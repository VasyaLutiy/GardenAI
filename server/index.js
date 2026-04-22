const express = require('express')
const cors = require('cors')
const multer = require('multer')
const { createClient } = require('redis')
const { createServer } = require('http')
const { WebSocketServer } = require('ws')
const crypto = require('crypto')
const { parseModelJson } = require('./lib/model-json')
const { validateEnvelope } = require('./lib/event-envelope')
const { buildMinStreamId } = require('./lib/stream-retention')
const { createRateLimiter } = require('./lib/rate-limit')
const { createLogger } = require('./lib/logger')
require('dotenv').config()

const app = express()
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean)
app.use(
  cors(
    corsOrigins.length
      ? {
          origin(origin, cb) {
            if (!origin || corsOrigins.includes(origin)) return cb(null, true)
            return cb(new Error('Not allowed by CORS'))
          }
        }
      : undefined
  )
)
app.use(express.json({ limit: '1mb' }))
const httpServer = createServer(app)
const upload = multer({
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024)
  }
})

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY
const AZURE_OPENAI_REALTIME_DEPLOYMENT = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT
const AZURE_OPENAI_VISION_DEPLOYMENT = process.env.AZURE_OPENAI_VISION_DEPLOYMENT
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'
const REALTIME_TOKEN_AUTH_SECRET = process.env.REALTIME_TOKEN_AUTH_SECRET || ''
const REALTIME_TOKEN_AUTH_HEADER = 'x-gardenai-realtime-token-secret'
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 24)
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SESSION_EVENTS_STREAM = 'stream:session-events'
const VISION_COMMANDS_STREAM = 'stream:vision-commands'
const ANALYSIS_RESULTS_STREAM = 'stream:analysis-results'
const DLQ_STREAM = 'stream:dlq'
const VISUAL_SESSION_STATE_PREFIX = 'state:session-visual:'
const ORCHESTRATOR_GROUP = 'orchestrator-group'
const VISION_GROUP = 'vision-group'
const PENDING_MIN_IDLE_MS = Number(process.env.PENDING_MIN_IDLE_MS || 60000)
const ANALYSIS_WAIT_TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS || 25000)
const STORAGE_CLEANUP_INTERVAL_MS = Number(process.env.STORAGE_CLEANUP_INTERVAL_MS || 60000)
const WS_PATH = '/ws'
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000)
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120)
const WS_RATE_LIMIT_MAX = Number(process.env.WS_RATE_LIMIT_MAX || 30)
const LOG_REQUESTS = process.env.LOG_REQUESTS === '1'
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const LOG_JSON = process.env.LOG_JSON !== '0'
const INTENT_CAPTURE_CONFIDENCE_THRESHOLD = Number(process.env.INTENT_CAPTURE_CONFIDENCE_THRESHOLD || 0.65)
const INTENT_CAPTURE_COOLDOWN_SEC = Number(process.env.INTENT_CAPTURE_COOLDOWN_SEC || 8)
const ANALYSIS_FAIL_FALLBACK_LIMIT = Number(process.env.ANALYSIS_FAIL_FALLBACK_LIMIT || 2)
const VISUAL_STATE_TTL_SEC = Number(process.env.VISUAL_STATE_TTL_SEC || 1800)
const TOOL_REPLY_TTL_SEC = Number(process.env.TOOL_REPLY_TTL_SEC || 120)

const redis = createClient({ url: REDIS_URL })
let redisReady = false
const sessionSockets = new Map()
const wss = new WebSocketServer({ server: httpServer, path: WS_PATH })
const apiLimiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX })
const wsLimiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: WS_RATE_LIMIT_MAX })
const logger = createLogger({
  service: 'gardenai-server',
  level: LOG_LEVEL,
  json: LOG_JSON
})
const appLogger = logger.child({ component: 'api' })
const redisLogger = logger.child({ component: 'redis' })
const wsLogger = logger.child({ component: 'ws' })
const orchestratorLogger = logger.child({ component: 'orchestrator' })
const visionLogger = logger.child({ component: 'vision-worker' })
const storageLogger = logger.child({ component: 'storage-worker' })
const azureLogger = logger.child({ component: 'azure' })
const metrics = {
  requests: 0,
  requestErrors: 0,
  realtimeTokens: 0,
  realtimeTokenErrors: 0,
  realtimeConnections: 0,
  realtimeConnectMs: 0,
  analyzeRequests: 0,
  eventAccepted: 0,
  eventDuplicate: 0,
  wsConnections: 0,
  analysisCompleted: 0,
  analysisFailed: 0,
  visionRetries: 0,
  dlqCount: 0,
  intentDetected: 0,
  captureRequested: 0,
  promptFallbackCount: 0
}

redis.on('ready', () => {
  redisReady = true
  redisLogger.info('Redis connected')
})
redis.on('end', () => {
  redisReady = false
  redisLogger.warn('Redis connection ended')
})
redis.on('error', (err) => {
  redisReady = false
  redisLogger.error('Redis error', { error: err.message })
})

if (require.main === module) {
  redis.connect().catch((err) => {
    redisReady = false
    redisLogger.error('Redis connect failed', { error: err.message })
  })
}

function ensureAzureConfig(res) {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
    return false
  }
  return true
}

function normalizeEndpoint(endpoint) {
  return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint
}

function buildDataUrlFromUpload(file) {
  const mime = file.mimetype || 'image/jpeg'
  const b64 = file.buffer.toString('base64')
  return `data:${mime};base64,${b64}`
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recordMetric(name) {
  metrics[name] = (metrics[name] || 0) + 1
}

function buildVisualStateKey(sessionId) {
  return `${VISUAL_SESSION_STATE_PREFIX}${sessionId}`
}

function buildToolReplyContextKey(toolCallId) {
  return `reply:tool:${toolCallId}`
}

function summarizeVisualState(event, previous = {}) {
  const payload = isObject(event.payload) ? event.payload : {}
  const next = {
    ...previous,
    sessionId: event.sessionId,
    correlationId: event.correlationId || previous.correlationId || null,
    activeTurnId: event.turnId || previous.activeTurnId || null,
    activeSnapshotId: event.snapshotId || previous.activeSnapshotId || null,
    analysisGoal: payload.analysisGoal || previous.analysisGoal || null,
    toolCallId: payload.toolCallId || previous.toolCallId || null,
    lastEventType: event.type,
    updatedAt: event.tsWallIso || new Date().toISOString(),
  }

  switch (event.type) {
    case 'capture.requested':
      next.captureState = 'requested'
      break
    case 'capture.accepted':
      next.captureState = 'captured'
      break
    case 'capture.rejected':
      next.captureState = 'failed'
      break
    case 'snapshot.available':
      next.captureState = 'captured'
      next.snapshotState = 'available'
      break
    case 'snapshot.upload.requested':
      next.snapshotState = 'uploading'
      break
    case 'snapshot.uploaded':
      next.snapshotState = 'uploaded'
      break
    case 'analysis.requested':
      next.analysisState = 'requested'
      next.snapshotState = 'analyzing'
      break
    case 'analysis.completed':
      next.analysisState = 'completed'
      next.snapshotState = 'completed'
      break
    case 'analysis.failed':
      next.analysisState = 'failed'
      next.snapshotState = 'failed'
      break
    case 'assistant.visual_guidance':
      next.lastGuidance = payload.reasonCode || null
      break
    default:
      break
  }

  return next
}

async function persistVisualState(client, event) {
  if (!client || typeof client.get !== 'function' || typeof client.set !== 'function' || !event?.sessionId) {
    return null
  }

  const key = buildVisualStateKey(event.sessionId)
  let previous = {}
  const raw = await client.get(key)
  if (raw) {
    try {
      previous = JSON.parse(raw)
    } catch {
      previous = {}
    }
  }
  const next = summarizeVisualState(event, isObject(previous) ? previous : {})
  await client.set(key, JSON.stringify(next), { EX: VISUAL_STATE_TTL_SEC })
  return next
}

async function setToolReplyContext(client, value) {
  if (!client || typeof client.set !== 'function' || !value?.toolCallId) {
    return
  }

  await client.set(
    buildToolReplyContextKey(value.toolCallId),
    JSON.stringify({
      toolCallId: value.toolCallId,
      sessionId: value.sessionId,
      correlationId: value.correlationId || null,
      turnId: value.turnId || null,
      snapshotId: value.snapshotId || null,
      analysisGoal: value.analysisGoal || null,
      status: value.status || 'pending',
      updatedAt: new Date().toISOString(),
    }),
    { EX: TOOL_REPLY_TTL_SEC }
  )
}

function visualSessionStateKey(sessionId) {
  return buildVisualStateKey(sessionId)
}

async function getVisualSessionState(client, sessionId) {
  const raw = await client.get(visualSessionStateKey(sessionId))
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function setVisualSessionState(client, sessionId, state, ttlSeconds = VISUAL_STATE_TTL_SEC) {
  await client.set(visualSessionStateKey(sessionId), JSON.stringify(state), { EX: ttlSeconds })
}

async function publishSessionEvent(client, event) {
  await client.xAdd(SESSION_EVENTS_STREAM, '*', {
    messageId: event.messageId,
    sessionId: event.sessionId,
    type: event.type,
    payload: JSON.stringify(event)
  })
  await client.publish(`chan:session:${event.sessionId}`, JSON.stringify(event))
  appLogger.debug('Session event published', {
    eventType: event.type,
    sessionId: event.sessionId,
    messageId: event.messageId,
    correlationId: event.correlationId || null
  })
}

async function enqueueSessionEventAtomically(client, event, stream = SESSION_EVENTS_STREAM) {
  const dedupeKey = `dedupe:${event.messageId}`
  const dedupeTtlSeconds = RETENTION_HOURS * 60 * 60
  const channel = `chan:session:${event.sessionId}`
  const payload = JSON.stringify(event)
  const script = `
    local dedupeKey = KEYS[1]
    local streamKey = KEYS[2]
    local channel = ARGV[1]
    local ttlSeconds = tonumber(ARGV[2])
    local payload = ARGV[3]
    local decoded = cjson.decode(payload)
    local streamType = redis.call('TYPE', streamKey)

    if streamType['ok'] ~= 'none' and streamType['ok'] ~= 'stream' then
      return { err = 'stream_key_wrong_type' }
    end

    if redis.call('EXISTS', dedupeKey) == 1 then
      return 0
    end

    redis.call('XADD', streamKey, '*',
      'messageId', decoded.messageId,
      'sessionId', decoded.sessionId,
      'type', decoded.type,
      'payload', payload
    )
    redis.call('PUBLISH', channel, payload)
    redis.call('SET', dedupeKey, '1', 'EX', ttlSeconds)
    return 1
  `

  const result = await client.sendCommand([
    'EVAL',
    script,
    '2',
    dedupeKey,
    stream,
    channel,
    String(dedupeTtlSeconds),
    payload
  ])

  return Number(result) === 1 ? 'accepted' : 'duplicate'
}

async function ensureStreamGroup(client, stream, group) {
  try {
    await client.xGroupCreate(stream, group, '$', { MKSTREAM: true })
  } catch (err) {
    if (!String(err.message || '').includes('BUSYGROUP')) throw err
  }
}

async function drainPendingStreamMessages(client, stream, group, consumerName, count, minIdleMs, handleMessage) {
  let startId = '0-0'

  while (true) {
    const result = await client.xAutoClaim(stream, group, consumerName, minIdleMs, startId, {
      COUNT: count
    })
    const messages = (result?.messages || []).filter(Boolean)
    if (!messages.length) {
      if (!result.nextId || result.nextId === startId || result.nextId === '0-0') return
      startId = result.nextId
      continue
    }

    for (const msg of messages) {
      await handleMessage(msg)
    }

    if (!result.nextId || result.nextId === startId || result.nextId === '0-0') return
    startId = result.nextId
  }
}

async function processOrchestratorMessage(client, msg) {
  const payload = JSON.parse(msg.message.payload || '{}')
  if (payload.type === 'analysis.requested') {
    const attempt = payload?.payload?.attempt || 1
    const analysisGoal = payload?.payload?.analysisGoal || null
    const toolCallId = payload?.payload?.toolCallId || payload?.payload?.callId || payload.causationId || null
    orchestratorLogger.info('Dispatching vision analyze command', {
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      correlationId: payload.correlationId || null,
      turnId: payload.turnId || payload?.payload?.turnId || null,
      snapshotId: payload.snapshotId || payload?.payload?.snapshotId || null,
      attempt
    })
    const currentState = await getVisualSessionState(client, payload.sessionId)
    const nextState = {
      ...(currentState || {}),
      sessionId: payload.sessionId,
      activeTurnId: payload.turnId || payload?.payload?.turnId || currentState?.activeTurnId || null,
      activeSnapshotId: payload.snapshotId || payload?.payload?.snapshotId || currentState?.activeSnapshotId || null,
      lastToolCallId: toolCallId || currentState?.lastToolCallId || null,
      lastCorrelationId: payload.correlationId || currentState?.lastCorrelationId || null,
      analysisGoal: analysisGoal || currentState?.analysisGoal || null,
      analysisState: 'requested',
      updatedAt: new Date().toISOString()
    }
    await setVisualSessionState(client, payload.sessionId, nextState)
    await setToolReplyContext(client, {
      toolCallId,
      sessionId: payload.sessionId,
      correlationId: payload.correlationId || payload.messageId,
      turnId: nextState.activeTurnId,
      snapshotId: nextState.activeSnapshotId,
      analysisGoal,
      status: 'pending'
    })
    const commandEvent = {
      messageId: crypto.randomUUID(),
      type: 'vision.analyze.command',
      sessionId: payload.sessionId,
      userId: payload.userId || null,
      correlationId: payload.correlationId || payload.messageId,
      causationId: payload.messageId,
      turnId: nextState.activeTurnId,
      snapshotId: nextState.activeSnapshotId,
      schemaVersion: payload.schemaVersion || '2.0',
      payload: {
        requestMessageId: payload.messageId,
        imageDataUrl: payload?.payload?.imageDataUrl,
        imageArtifactKey: payload?.payload?.imageArtifactKey,
        replyKey: payload?.payload?.replyKey,
        snapshotId: nextState.activeSnapshotId,
        turnId: nextState.activeTurnId,
        toolCallId,
        analysisGoal,
        attempt
      }
    }

    await client.xAdd(VISION_COMMANDS_STREAM, '*', {
      messageId: commandEvent.messageId,
      sessionId: commandEvent.sessionId,
      type: commandEvent.type,
      payload: JSON.stringify(commandEvent)
    })
  } else if (payload.type === 'intent.detected') {
    recordMetric('intentDetected')
    const detectedIntent = payload?.payload?.intent
    const confidence = Number(payload?.payload?.confidence || 0)
    const shouldCapture =
      (detectedIntent === 'diagnose_plant' || detectedIntent === 'identify_plant') &&
      confidence >= INTENT_CAPTURE_CONFIDENCE_THRESHOLD

    if (shouldCapture) {
      const cooldownKey = `orchestrator:capture-cooldown:${payload.sessionId}:${detectedIntent}`
      const cooldownSet = await client.set(cooldownKey, '1', {
        NX: true,
        EX: INTENT_CAPTURE_COOLDOWN_SEC
      })
      if (cooldownSet) {
        const turnId = crypto.randomUUID()
        const snapshotId = crypto.randomUUID()
        orchestratorLogger.info('Emitting capture.requested from intent', {
          sessionId: payload.sessionId,
          correlationId: payload.correlationId || payload.messageId,
          turnId,
          snapshotId,
          detectedIntent,
          confidence
        })
        const captureRequested = {
          messageId: crypto.randomUUID(),
          type: 'capture.requested',
          sessionId: payload.sessionId,
          correlationId: payload.correlationId || payload.messageId,
          causationId: payload.messageId,
          turnId,
          snapshotId,
          schemaVersion: '2.0',
          tsWallIso: new Date().toISOString(),
          payload: {
            reason: `intent:${detectedIntent}`,
            captureMode: 'fresh_photo',
            requestedBy: 'orchestrator'
          }
        }
        recordMetric('captureRequested')
        await publishSessionEvent(client, captureRequested)
      }
    } else if (detectedIntent === 'diagnose_plant' || detectedIntent === 'identify_plant') {
      const promptEvent = {
        messageId: crypto.randomUUID(),
        type: 'assistant.prompt',
        sessionId: payload.sessionId,
        correlationId: payload.correlationId || payload.messageId,
        causationId: payload.messageId,
        schemaVersion: '1.0',
        tsWallIso: new Date().toISOString(),
        payload: {
          text: 'Please show the plant closer and describe the issue again.',
          reasonCode: 'low_intent_confidence'
        }
      }
      recordMetric('promptFallbackCount')
      await publishSessionEvent(client, promptEvent)
      orchestratorLogger.info('Emitting assistant.prompt for low intent confidence', {
        sessionId: payload.sessionId,
        correlationId: payload.correlationId || payload.messageId,
        detectedIntent,
        confidence
      })
    }
  } else if (payload.type === 'snapshot.available' || payload.type === 'snapshot.upload.requested') {
    await persistVisualState(client, payload)
    orchestratorLogger.info('Snapshot lifecycle updated', {
      sessionId: payload.sessionId,
      eventType: payload.type,
      correlationId: payload.correlationId || null,
      turnId: payload.turnId || null,
      snapshotId: payload.snapshotId || null
    })
  } else if (payload.type === 'snapshot.uploaded') {
    await persistVisualState(client, payload)
    const currentState = await getVisualSessionState(client, payload.sessionId)
    const analysisRequested = {
      messageId: crypto.randomUUID(),
      type: 'analysis.requested',
      sessionId: payload.sessionId,
      userId: payload.userId || null,
      correlationId: payload.correlationId || payload.messageId,
      causationId: payload.causationId || payload.messageId,
      turnId: payload.turnId || currentState?.activeTurnId || null,
      snapshotId: payload.snapshotId || currentState?.activeSnapshotId || null,
      tsWallIso: new Date().toISOString(),
      schemaVersion: payload.schemaVersion || '2.0',
      payload: {
        imageArtifactKey: payload?.payload?.artifactKey || null,
        replyKey: payload?.payload?.replyKey || null,
        toolCallId: payload?.payload?.toolCallId || null,
        analysisGoal: payload?.payload?.analysisGoal || currentState?.analysisGoal || 'diagnose',
        attempt: 1
      }
    }
    await publishSessionEvent(client, analysisRequested)
    orchestratorLogger.info('Published analysis.requested from snapshot.uploaded', {
      sessionId: payload.sessionId,
      correlationId: analysisRequested.correlationId,
      turnId: analysisRequested.turnId || null,
      snapshotId: analysisRequested.snapshotId || null
    })
  } else if (payload.type === 'capture.requested' || payload.type === 'capture.accepted' || payload.type === 'capture.rejected') {
    await persistVisualState(client, payload)
    orchestratorLogger.info('Visual capture lifecycle updated', {
      sessionId: payload.sessionId,
      eventType: payload.type,
      correlationId: payload.correlationId || null,
      turnId: payload.turnId || null,
      snapshotId: payload.snapshotId || null
    })
  } else if (payload.type === 'analysis.completed') {
    await persistVisualState(client, payload)
    await setToolReplyContext(client, {
      toolCallId: payload.toolCallId || payload?.payload?.toolCallId || null,
      sessionId: payload.sessionId,
      correlationId: payload.correlationId || payload.messageId,
      turnId: payload.turnId || null,
      snapshotId: payload.snapshotId || null,
      status: 'completed'
    })
    orchestratorLogger.info('Visual analysis completed', {
      sessionId: payload.sessionId,
      correlationId: payload.correlationId || null,
      turnId: payload.turnId || null,
      snapshotId: payload.snapshotId || null
    })
  } else if (payload.type === 'analysis.failed') {
    await persistVisualState(client, payload)
    const corr = payload.correlationId || payload.messageId
    await setToolReplyContext(client, {
      toolCallId: payload.toolCallId || payload?.payload?.toolCallId || null,
      sessionId: payload.sessionId,
      correlationId: corr,
      turnId: payload.turnId || null,
      snapshotId: payload.snapshotId || null,
      status: 'failed'
    })
    const failCountKey = `orchestrator:analysis-fail-count:${corr}`
    const count = await client.incr(failCountKey)
    if (count === 1) {
      await client.expire(failCountKey, 600)
    }
    if (count <= ANALYSIS_FAIL_FALLBACK_LIMIT) {
      const promptEvent = {
        messageId: crypto.randomUUID(),
        type: 'assistant.visual_guidance',
        sessionId: payload.sessionId,
        correlationId: corr,
        causationId: payload.messageId,
        turnId: payload.turnId || null,
        snapshotId: payload.snapshotId || null,
        schemaVersion: '2.0',
        tsWallIso: new Date().toISOString(),
        payload: {
          text: 'I could not analyze the photo. Please retake it with better lighting and closer focus on the leaves.',
          reasonCode: 'analysis_failed'
        }
      }
      recordMetric('promptFallbackCount')
      await publishSessionEvent(client, promptEvent)
      orchestratorLogger.warn('Emitting assistant.visual_guidance after analysis failure', {
        sessionId: payload.sessionId,
        correlationId: corr,
        turnId: payload.turnId || null,
        snapshotId: payload.snapshotId || null,
        failureCount: count,
        error: payload?.payload?.error || 'unknown'
      })
    }
    const state = await getVisualSessionState(client, payload.sessionId)
    if (state) {
      await setVisualSessionState(client, payload.sessionId, {
        ...state,
        analysisState: 'failed',
        lastAnalysisStatus: 'failed',
        lastAnalysisError: payload?.payload?.error || 'unknown',
        updatedAt: new Date().toISOString()
      })
    }
  }

  await client.xAck(SESSION_EVENTS_STREAM, ORCHESTRATOR_GROUP, msg.id)
}

async function processVisionCommandMessage(client, msg) {
  const event = JSON.parse(msg.message.payload || '{}')
  await processVisionCommand(client, event)
  await client.xAck(VISION_COMMANDS_STREAM, VISION_GROUP, msg.id)
}

async function analyzePlantImageWithAzure(dataUrl) {
  const endpoint = normalizeEndpoint(AZURE_OPENAI_ENDPOINT)
  const url = `${endpoint}/openai/deployments/${AZURE_OPENAI_VISION_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`
  const instructions =
    'You are a gardening assistant. Analyze a plant photo and return strict JSON only with keys: species, confidence, diagnoses, suggestions, urgency, disclaimer. ' +
    'confidence is a number 0..1. diagnoses and suggestions are string arrays. urgency is one of: low, medium, high.'

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': AZURE_OPENAI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: instructions },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this plant image and provide care guidance.' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      temperature: 0.2,
      max_tokens: 700
    })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`azure_vision_failed: ${text}`)
  }

  const result = await response.json()
  const content = result?.choices?.[0]?.message?.content || ''
  const parsed = parseModelJson(content)
  if (parsed) return parsed

  return {
    species: 'Unknown',
    confidence: 0.0,
    diagnoses: ['Could not parse model JSON output.'],
    suggestions: [content || 'Try another image with better lighting and focus.'],
    urgency: 'medium',
    disclaimer: 'AI-generated guidance. Validate with a local plant specialist when needed.'
  }
}

async function startOrchestratorLoop() {
  const client = redis.duplicate()
  await client.connect()
  const consumerName = `orchestrator-${process.pid}`
  await ensureStreamGroup(client, SESSION_EVENTS_STREAM, ORCHESTRATOR_GROUP)
  orchestratorLogger.info('Orchestrator loop started', { consumerName, stream: SESSION_EVENTS_STREAM })

  while (true) {
    try {
      await drainPendingStreamMessages(
        client,
        SESSION_EVENTS_STREAM,
        ORCHESTRATOR_GROUP,
        consumerName,
        20,
        PENDING_MIN_IDLE_MS,
        async (msg) => processOrchestratorMessage(client, msg)
      )

      const entries = await client.xReadGroup(
        ORCHESTRATOR_GROUP,
        consumerName,
        [{ key: SESSION_EVENTS_STREAM, id: '>' }],
        { COUNT: 20, BLOCK: 5000 }
      )
      if (!entries) continue

      for (const stream of entries) {
        for (const msg of stream.messages) {
          await processOrchestratorMessage(client, msg)
        }
      }
    } catch (err) {
      orchestratorLogger.error('Orchestrator loop error', { error: err.message })
      await sleep(1000)
    }
  }
}

async function startVisionWorkerLoop() {
  const client = redis.duplicate()
  await client.connect()
  const consumerName = `vision-${process.pid}`
  await ensureStreamGroup(client, VISION_COMMANDS_STREAM, VISION_GROUP)
  visionLogger.info('Vision worker loop started', { consumerName, stream: VISION_COMMANDS_STREAM })

  while (true) {
    try {
      await drainPendingStreamMessages(
        client,
        VISION_COMMANDS_STREAM,
        VISION_GROUP,
        consumerName,
        10,
        PENDING_MIN_IDLE_MS,
        async (msg) => processVisionCommandMessage(client, msg)
      )

      const entries = await client.xReadGroup(
        VISION_GROUP,
        consumerName,
        [{ key: VISION_COMMANDS_STREAM, id: '>' }],
        { COUNT: 10, BLOCK: 5000 }
      )
      if (!entries) continue

      for (const stream of entries) {
        for (const msg of stream.messages) {
          await processVisionCommandMessage(client, msg)
        }
      }
    } catch (err) {
      visionLogger.error('Vision worker loop error', { error: err.message })
      await sleep(1000)
    }
  }
}

async function processVisionCommand(client, event) {
  const command = event.payload || {}
  const attempt = Number(command.attempt || 1)

  try {
    const imageDataUrl = command.imageDataUrl || (command.imageArtifactKey ? await client.get(command.imageArtifactKey) : null)
    if (!imageDataUrl) {
      throw new Error('image_artifact_missing')
    }
    visionLogger.info('Running vision analysis', {
      sessionId: event.sessionId,
      correlationId: event.correlationId || null,
      requestMessageId: command.requestMessageId || null,
      attempt
    })
    const analysis = await analyzePlantImageWithAzure(imageDataUrl)
    const resultEvent = {
      messageId: crypto.randomUUID(),
      type: 'analysis.completed',
      sessionId: event.sessionId,
      correlationId: event.correlationId,
      causationId: event.messageId,
      schemaVersion: event.schemaVersion || '2.0',
      turnId: event.turnId || command.turnId || null,
      snapshotId: event.snapshotId || command.snapshotId || null,
      toolCallId: command.toolCallId || null,
      payload: analysis
    }

    await client.xAdd(ANALYSIS_RESULTS_STREAM, '*', {
      messageId: resultEvent.messageId,
      sessionId: resultEvent.sessionId,
      type: resultEvent.type,
      payload: JSON.stringify(resultEvent)
    })
    recordMetric('analysisCompleted')
    const state = await getVisualSessionState(client, event.sessionId)
    if (state) {
      await setVisualSessionState(client, event.sessionId, {
        ...state,
        analysisState: 'completed',
        lastAnalysisStatus: 'completed',
        lastToolCallId: command.toolCallId || state.lastToolCallId || null,
        lastAnalysis: analysis,
        updatedAt: new Date().toISOString()
      })
    }
    visionLogger.info('Vision analysis completed', {
      sessionId: event.sessionId,
      correlationId: event.correlationId || null,
      resultMessageId: resultEvent.messageId
    })
    await publishSessionEvent(client, resultEvent)
    if (command.replyKey) {
      await client.set(command.replyKey, JSON.stringify(analysis), { EX: TOOL_REPLY_TTL_SEC })
    }
    if (command.toolCallId) {
      await setToolReplyContext(client, {
        toolCallId: command.toolCallId,
        sessionId: event.sessionId,
        correlationId: event.correlationId || null,
        turnId: resultEvent.turnId,
        snapshotId: resultEvent.snapshotId,
        analysisGoal: command.analysisGoal || null,
        status: 'completed'
      })
    }
    if (command.imageArtifactKey) {
      await client.del(command.imageArtifactKey)
    }
    return
  } catch (err) {
    if (attempt < 3) {
      recordMetric('visionRetries')
      visionLogger.warn('Vision analysis failed, retrying', {
        sessionId: event.sessionId,
        correlationId: event.correlationId || null,
        attempt,
        error: err.message
      })
      const retryEvent = {
        ...event,
        payload: {
          ...command,
          attempt: attempt + 1
        }
      }
      await sleep([300, 1000, 2500][attempt - 1] || 2500)
      await client.xAdd(VISION_COMMANDS_STREAM, '*', {
        messageId: retryEvent.messageId,
        sessionId: retryEvent.sessionId,
        type: retryEvent.type,
        payload: JSON.stringify(retryEvent)
      })
      return
    }

    visionLogger.error('Vision analysis failed after retries', {
      sessionId: event.sessionId,
      correlationId: event.correlationId || null,
      attempt,
      error: err.message
    })
    const failedResult = {
      messageId: crypto.randomUUID(),
      type: 'analysis.failed',
      sessionId: event.sessionId,
      correlationId: event.correlationId,
      causationId: event.messageId,
      schemaVersion: event.schemaVersion || '2.0',
      turnId: event.turnId || command.turnId || null,
      snapshotId: event.snapshotId || command.snapshotId || null,
      toolCallId: command.toolCallId || null,
      payload: {
        error: err.message
      }
    }
    await client.xAdd(ANALYSIS_RESULTS_STREAM, '*', {
      messageId: failedResult.messageId,
      sessionId: failedResult.sessionId,
      type: failedResult.type,
      payload: JSON.stringify(failedResult)
    })
    recordMetric('analysisFailed')
    const state = await getVisualSessionState(client, event.sessionId)
    if (state) {
      await setVisualSessionState(client, event.sessionId, {
        ...state,
        analysisState: 'failed',
        lastAnalysisStatus: 'failed',
        lastToolCallId: command.toolCallId || state.lastToolCallId || null,
        lastAnalysisError: err.message,
        updatedAt: new Date().toISOString()
      })
    }
    await client.xAdd(DLQ_STREAM, '*', {
      messageId: failedResult.messageId,
      sessionId: failedResult.sessionId,
      type: failedResult.type,
      payload: JSON.stringify({
        failedCommand: event,
        reason: err.message
      })
    })
    recordMetric('dlqCount')
    await publishSessionEvent(client, failedResult)
    if (command.replyKey) {
      await client.set(
        command.replyKey,
        JSON.stringify({ error: 'Analysis failed after retries', details: err.message }),
        { EX: TOOL_REPLY_TTL_SEC }
      )
    }
    if (command.toolCallId) {
      await setToolReplyContext(client, {
        toolCallId: command.toolCallId,
        sessionId: event.sessionId,
        correlationId: event.correlationId || null,
        turnId: failedResult.turnId,
        snapshotId: failedResult.snapshotId,
        analysisGoal: command.analysisGoal || null,
        status: 'failed'
      })
    }
    if (command.imageArtifactKey) {
      await client.del(command.imageArtifactKey)
    }
  }
}

async function startStorageWorkerLoop() {
  const client = redis.duplicate()
  await client.connect()
  const streams = [SESSION_EVENTS_STREAM, VISION_COMMANDS_STREAM, ANALYSIS_RESULTS_STREAM, DLQ_STREAM]
  storageLogger.info('Storage worker loop started', {
    streams,
    retentionHours: RETENTION_HOURS,
    intervalMs: STORAGE_CLEANUP_INTERVAL_MS
  })

  while (true) {
    try {
      const minId = buildMinStreamId(Date.now(), RETENTION_HOURS)
      for (const stream of streams) {
        // Keep stream entries only for the configured retention window.
        await client.sendCommand(['XTRIM', stream, 'MINID', '~', minId])
      }
      storageLogger.debug('Storage cleanup completed', { minId })
      await sleep(STORAGE_CLEANUP_INTERVAL_MS)
    } catch (err) {
      storageLogger.error('Storage worker loop error', { error: err.message })
      await sleep(2000)
    }
  }
}

let pipelinesStarted = false
async function startBackgroundPipelines() {
  if (pipelinesStarted) return
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_VISION_DEPLOYMENT) {
    appLogger.warn('Background pipelines are disabled: Azure vision env config is incomplete')
    return
  }
  pipelinesStarted = true
  startOrchestratorLoop().catch((err) => appLogger.error('Failed to start orchestrator loop', { error: err.message }))
  startVisionWorkerLoop().catch((err) => appLogger.error('Failed to start vision worker loop', { error: err.message }))
  startStorageWorkerLoop().catch((err) => appLogger.error('Failed to start storage worker loop', { error: err.message }))
}

function sendError(res, status, code, message, requestId, details) {
  return res.status(status).json({
    error: message,
    code,
    requestId,
    details: details || null
  })
}

function addSocketToSession(sessionId, socket) {
  const bucket = sessionSockets.get(sessionId) || new Set()
  bucket.add(socket)
  sessionSockets.set(sessionId, bucket)
}

function removeSocketFromSession(sessionId, socket) {
  const bucket = sessionSockets.get(sessionId)
  if (!bucket) return
  bucket.delete(socket)
  if (bucket.size === 0) sessionSockets.delete(sessionId)
}

function broadcastToSession(sessionId, message) {
  const bucket = sessionSockets.get(sessionId)
  if (!bucket) return
  for (const socket of bucket) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message)
    }
  }
}

let wsFanoutStarted = false
async function startWebSocketFanout() {
  if (wsFanoutStarted) return
  const subscriber = redis.duplicate()
  await subscriber.connect()
  wsLogger.info('Starting websocket fanout subscriber')
  await subscriber.pSubscribe('chan:session:*', (message, channel) => {
    const sessionId = channel.replace('chan:session:', '')
    broadcastToSession(sessionId, message)
    wsLogger.debug('Fanout message delivered', { sessionId, channel })
  })
  wsFanoutStarted = true
  wsLogger.info('Websocket fanout subscriber started')
}

wss.on('connection', (socket, req) => {
  const requestUrl = new URL(req.url, 'http://localhost')
  const sessionId = requestUrl.searchParams.get('sessionId')
  if (!sessionId) {
    socket.close(1008, 'sessionId is required')
    wsLogger.warn('Websocket rejected: missing sessionId')
    return
  }
  const clientKey = req.socket.remoteAddress || 'unknown'
  const verdict = wsLimiter.check(clientKey)
  if (!verdict.allowed) {
    socket.close(1013, 'rate limited')
    wsLogger.warn('Websocket rejected: rate limited', { clientKey })
    return
  }

  addSocketToSession(sessionId, socket)
  recordMetric('wsConnections')
  wsLogger.info('Websocket connected', { sessionId, clientKey })
  socket.send(
    JSON.stringify({
      type: 'ws.connected',
      sessionId,
      tsWallIso: new Date().toISOString()
    })
  )

  socket.on('close', () => {
    removeSocketFromSession(sessionId, socket)
    wsLogger.info('Websocket disconnected', { sessionId, clientKey })
  })
})

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID()
  res.setHeader('x-request-id', req.requestId)
  recordMetric('requests')
  const startedAt = Date.now()
  res.on('finish', () => {
    if (res.statusCode >= 400) recordMetric('requestErrors')
    if (LOG_REQUESTS) {
      appLogger.info('Request completed', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        requestId: req.requestId
      })
    }
  })
  next()
})

app.use('/api', (req, res, next) => {
  const key = req.ip || 'unknown'
  const verdict = apiLimiter.check(key)
  res.setHeader('x-rate-limit-limit', verdict.limit)
  res.setHeader('x-rate-limit-remaining', verdict.remaining)
  res.setHeader('x-rate-limit-reset', verdict.resetAt)
  if (!verdict.allowed) {
    return sendError(res, 429, 'rate_limited', 'Rate limit exceeded', req.requestId)
  }
  return next()
})

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    redisReady,
    uptimeSec: Math.floor(process.uptime())
  })
})

app.get('/metrics', (req, res) => {
  res.json({
    ...metrics,
    redisReady,
    uptimeSec: Math.floor(process.uptime())
  })
})

function validateRealtimeTokenAuth(req, res) {
  if (!REALTIME_TOKEN_AUTH_SECRET) return null
  const supplied = req.get(REALTIME_TOKEN_AUTH_HEADER)
  if (supplied === REALTIME_TOKEN_AUTH_SECRET) return null
  return sendError(
    res,
    401,
    'unauthorized',
    'Missing or invalid realtime token auth secret',
    req.requestId
  )
}

async function handleRealtimeTokenRequest(req, res, deps = {}) {
  if (REALTIME_TOKEN_AUTH_SECRET) {
    const authResponse = validateRealtimeTokenAuth(req, res)
    if (authResponse) return authResponse
  }

  if (!ensureAzureConfig(res)) {
    return sendError(
      res,
      500,
      'azure_not_configured',
      'Azure OpenAI is not configured',
      req.requestId
    )
  }
  if (!AZURE_OPENAI_REALTIME_DEPLOYMENT) {
    return sendError(
      res,
      500,
      'missing_realtime_deployment',
      'Missing AZURE_OPENAI_REALTIME_DEPLOYMENT in server .env',
      req.requestId
    )
  }

  try {
    const fetchImpl = deps.fetchImpl || fetch
    const endpoint = normalizeEndpoint(AZURE_OPENAI_ENDPOINT)
    const url = `${endpoint}/openai/v1/realtime/client_secrets`

    // client_secrets поддерживает только базовые поля.
    // Инструменты, persona и VAD настраиваются через session.update на клиенте.
    const body = {
      session: {
        type: 'realtime',
        model: AZURE_OPENAI_REALTIME_DEPLOYMENT,
      }
    }

    if (LOG_REQUESTS) {
      azureLogger.info('Requesting Azure realtime client secret', {
        endpoint,
        deployment: AZURE_OPENAI_REALTIME_DEPLOYMENT,
        requestId: req.requestId
      })
    }

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'api-key': AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const text = await response.text()
      recordMetric('realtimeTokenErrors')
      azureLogger.error('Azure realtime client secret request failed', {
        status: response.status,
        requestId: req.requestId,
        details: text?.slice ? text.slice(0, 1000) : text
      })
      return sendError(
        res,
        502,
        'azure_realtime_secret_failed',
        'Failed to mint Azure realtime client secret',
        req.requestId,
        text
      )
    }

    const data = await response.json()
    recordMetric('realtimeTokens')
    azureLogger.info('Azure realtime client secret minted', {
      requestId: req.requestId,
      deployment: AZURE_OPENAI_REALTIME_DEPLOYMENT,
      expiresAt: data?.expires_at || null
    })
    return res.json({
      token: data?.value,
      expiresAt: data?.expires_at,
      model: AZURE_OPENAI_REALTIME_DEPLOYMENT,
      realtimeUrl: `${endpoint}/openai/v1/realtime/calls`
    })
  } catch (err) {
    recordMetric('realtimeTokenErrors')
    return sendError(
      res,
      500,
      'realtime_token_error',
      'Realtime token error',
      req.requestId,
      err.message
    )
  }
}

app.get('/api/realtime-token', (req, res) => handleRealtimeTokenRequest(req, res))

app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
  if (!ensureAzureConfig(res)) {
    return sendError(
      res,
      500,
      'azure_not_configured',
      'Azure OpenAI is not configured',
      req.requestId
    )
  }
  if (!AZURE_OPENAI_VISION_DEPLOYMENT) {
    return sendError(
      res,
      500,
      'missing_vision_deployment',
      'Missing AZURE_OPENAI_VISION_DEPLOYMENT in server .env',
      req.requestId
    )
  }
  if (!req.file) {
    return sendError(res, 400, 'no_image_uploaded', 'No image uploaded', req.requestId)
  }

  if (!redisReady) {
    return sendError(
      res,
      503,
      'redis_unavailable',
      'Redis is unavailable. Try again shortly.',
      req.requestId
    )
  }

  try {
    recordMetric('analyzeRequests')
    const messageId = crypto.randomUUID()
    const sessionId = req.body?.sessionId || `upload-${messageId}`
    const correlationId = req.body?.correlationId || messageId
    const causationId = req.body?.causationId || req.requestId
    const turnId = req.body?.turnId || crypto.randomUUID()
    const snapshotId = req.body?.snapshotId || crypto.randomUUID()
    const toolCallId = req.body?.toolCallId || null
    const analysisGoal = req.body?.analysisGoal || 'diagnose'
    const captureTs = req.body?.captureTs || new Date().toISOString()
    const framingHint = req.body?.framingHint || null
    const uploadSource = req.body?.source || 'http_upload'
    const replyKey = `analysis:reply:${messageId}`
    const imageArtifactKey = `artifact:image:${messageId}`
    const imageTtl = RETENTION_HOURS * 60 * 60
    await redis.set(imageArtifactKey, buildDataUrlFromUpload(req.file), { EX: imageTtl })
    await setVisualSessionState(redis, sessionId, {
      sessionId,
      activeTurnId: turnId,
      activeSnapshotId: snapshotId,
      analysisState: 'requested',
      analysisGoal,
      snapshotState: 'uploaded',
      lastToolCallId: toolCallId,
      lastCorrelationId: correlationId,
      updatedAt: new Date().toISOString()
    })
    await setToolReplyContext(redis, {
      toolCallId,
      sessionId,
      correlationId,
      turnId,
      snapshotId,
      analysisGoal,
      status: 'pending'
    })
    const event = {
      messageId,
      type: 'snapshot.uploaded',
      sessionId,
      userId: req.body?.userId || null,
      seq: null,
      tsMonotonicMs: null,
      tsWallIso: new Date().toISOString(),
      correlationId,
      causationId,
      turnId,
      snapshotId,
      schemaVersion: '2.0',
      payload: {
        artifactKey: imageArtifactKey,
        replyKey,
        toolCallId,
        analysisGoal,
        mimeType: req.file.mimetype || 'image/jpeg',
        captureTs,
        framingHint,
        source: uploadSource,
      }
    }
    appLogger.info('Analysis requested', {
      requestId: req.requestId,
      sessionId: event.sessionId,
      messageId,
      correlationId: event.correlationId,
      turnId,
      snapshotId,
      toolCallId,
      legacySnapshot: !req.body?.snapshotId
    })

    await publishSessionEvent(redis, event)

    const startedAt = Date.now()
    while (Date.now() - startedAt < ANALYSIS_WAIT_TIMEOUT_MS) {
      const state = await getVisualSessionState(redis, event.sessionId)
      if (state?.analysisState === 'completed' && state?.lastAnalysis) {
        await redis.del(replyKey)
        appLogger.info('Analysis request completed from orchestration state', {
          requestId: req.requestId,
          sessionId: event.sessionId,
          correlationId: event.correlationId,
          durationMs: Date.now() - startedAt
        })
        return res.json(state.lastAnalysis)
      }
      if (state?.analysisState === 'failed' && state?.lastAnalysisError) {
        await redis.del(replyKey)
        appLogger.warn('Analysis request failed from orchestration state', {
          requestId: req.requestId,
          sessionId: event.sessionId,
          correlationId: event.correlationId,
          details: state.lastAnalysisError
        })
        return sendError(
          res,
          502,
          'analysis_failed',
          'Analysis failed after retries',
          req.requestId,
          state.lastAnalysisError
        )
      }
      const raw = await redis.get(replyKey)
      if (raw) {
        await redis.del(replyKey)
        const parsed = JSON.parse(raw)
        if (parsed && parsed.error) {
          appLogger.warn('Analysis request failed', {
            requestId: req.requestId,
            sessionId: event.sessionId,
            correlationId: event.correlationId,
            details: parsed.details || parsed.error
          })
          return sendError(
            res,
            502,
            'analysis_failed',
            'Analysis failed after retries',
            req.requestId,
            parsed.details || parsed.error
          )
        }
        appLogger.info('Analysis request completed', {
          requestId: req.requestId,
          sessionId: event.sessionId,
          correlationId: event.correlationId,
          durationMs: Date.now() - startedAt
        })
        return res.json(parsed)
      }
      await sleep(200)
    }

    return sendError(
      res,
      504,
      'analysis_timeout',
      'Analysis timeout waiting for worker result',
      req.requestId
    )
  } catch (err) {
    return sendError(res, 500, 'analysis_error', 'Analysis error', req.requestId, err.message)
  }
})

async function handleEventIngestRequest(req, res, deps = {}) {
  const redisClient = deps.redisClient || redis
  const isRedisReady = typeof deps.redisReady === 'boolean' ? deps.redisReady : redisReady

  if (!isRedisReady) {
    return sendError(
      res,
      503,
      'redis_unavailable',
      'Redis is unavailable. Try again shortly.',
      req.requestId
    )
  }

  const validationError = validateEnvelope(req.body)
  if (validationError) {
    return sendError(res, 400, 'invalid_event_envelope', validationError, req.requestId)
  }

  if (req.body.type === 'analysis.completed' || req.body.type === 'analysis.failed') {
    const visualState = await getVisualSessionState(redisClient, req.body.sessionId)
    if (!visualState?.activeTurnId) {
      return sendError(
        res,
        409,
        'orchestration_state_missing',
        'Visual analysis events require active orchestration state',
        req.requestId
      )
    }
    if (req.body.turnId && visualState.activeTurnId !== req.body.turnId) {
      return sendError(
        res,
        409,
        'turn_mismatch',
        'Visual analysis event turnId does not match orchestration state',
        req.requestId
      )
    }
  }

  const event = {
    messageId: req.body.messageId,
    type: req.body.type,
    sessionId: req.body.sessionId,
    userId: req.body.userId || null,
    seq: Number.isFinite(req.body.seq) ? req.body.seq : null,
    tsMonotonicMs: Number.isFinite(req.body.tsMonotonicMs) ? req.body.tsMonotonicMs : null,
    tsWallIso: req.body.tsWallIso || new Date().toISOString(),
    correlationId: req.body.correlationId || null,
    causationId: req.body.causationId || null,
    turnId: req.body.turnId || null,
    snapshotId: req.body.snapshotId || null,
    schemaVersion: req.body.schemaVersion || '2.0',
    payload: req.body.payload
  }

  try {
    const result = await enqueueSessionEventAtomically(redisClient, event)
    if (result === 'duplicate') {
      recordMetric('eventDuplicate')
      appLogger.info('Duplicate event ignored', {
        requestId: req.requestId,
        messageId: event.messageId,
        type: event.type,
        sessionId: event.sessionId
      })
      return res.status(200).json({
        status: 'duplicate',
        messageId: event.messageId,
        requestId: req.requestId
      })
    }

    recordMetric('eventAccepted')
    appLogger.info('Event accepted', {
      requestId: req.requestId,
      messageId: event.messageId,
      type: event.type,
      sessionId: event.sessionId,
      correlationId: event.correlationId || null
    })
    return res.status(202).json({
      status: 'accepted',
      messageId: event.messageId,
      stream: SESSION_EVENTS_STREAM,
      requestId: req.requestId
    })
  } catch (err) {
    return sendError(
      res,
      500,
      'event_publish_failed',
      'Failed to publish event',
      req.requestId,
      err.message
    )
  }
}

app.post('/api/events', (req, res) => handleEventIngestRequest(req, res, req.app.locals.eventIngestDeps || {}))

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 413, 'file_too_large', 'Uploaded file is too large', req.requestId)
  }
  if (err) {
    return sendError(
      res,
      500,
      'internal_error',
      'Unexpected server error',
      req.requestId,
      err.message
    )
  }
  return next()
})

const port = process.env.PORT || 3000

if (require.main === module) {
  httpServer.listen(port, () => {
    appLogger.info('GardenAI server started', { port })
    startWebSocketFanout().catch((err) => {
      wsLogger.error('WebSocket fanout startup error', { error: err.message })
    })
    startBackgroundPipelines().catch((err) => {
      appLogger.error('Background pipeline startup error', { error: err.message })
    })
  })
}

module.exports = {
  app,
  drainPendingStreamMessages,
  enqueueSessionEventAtomically,
  REALTIME_TOKEN_AUTH_HEADER,
  handleEventIngestRequest,
  processVisionCommand,
  handleRealtimeTokenRequest,
  processOrchestratorMessage,
  processVisionCommandMessage
}
