import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Image,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native'
import { CameraView } from 'expo-camera'
import { useCamera } from '../hooks/useCamera'
import { useWebSocket } from '../hooks/useWebSocket'
import { useRealtime } from '../hooks/useRealtime'
import { uploadImageForAnalysis, postEvent, type AnalysisResult } from '../lib/api'
import { buildEnvelope, createId } from '../lib/eventBus'
import { inferIntentFromText } from '../lib/intent'
import {
  LOCAL_CAPTURE_COOLDOWN_MS,
  RECENT_EVENTS_LIMIT,
  INTENT_DEDUP_TTL_MS,
  SNAPSHOT_BUFFER_FRESHNESS_MS,
  SNAPSHOT_BUFFER_LIMIT,
  TOOL_RESULT_TTL_MS,
} from '../config'
import { dlog } from '../lib/debugLog'

type AppEvent = Record<string, unknown>
type FramingHint = 'whole_plant' | 'leaf_closeup' | 'stem_closeup' | 'soil' | 'problem_area'
type CaptureMode = 'latest_buffered' | 'fresh_photo'
type AnalysisGoal = 'identify' | 'diagnose' | 'care_advice'
type CaptureState = 'idle' | 'awaiting_capture' | 'captured' | 'failed'
type AnalysisState = 'idle' | 'analyzing' | 'completed' | 'failed'
type AnalysisStatus = 'idle' | 'pending' | 'completed' | 'failed'

interface VisualSessionState {
  activeTurnId: string | null
  activeSnapshotId: string | null
  correlationId: string | null
  captureState: CaptureState
  analysisState: AnalysisState
  lastAnalysisStatus: AnalysisStatus
}

interface BufferedSnapshot {
  snapshotId: string
  turnId: string
  correlationId: string
  uri: string
  captureTs: number
  framingHint?: FramingHint
}

interface PendingToolCall {
  callId: string
  name: string
  turnId?: string
  snapshotId?: string
  correlationId: string
  createdAt: number
  analysisGoal?: AnalysisGoal
}

function normalizeAnalysisGoal(intent: string): AnalysisGoal | null {
  if (intent === 'identify_plant') return 'identify'
  if (intent === 'diagnose_plant') return 'diagnose'
  return null
}

export default function MainScreen() {
  const sessionId = useMemo(() => createId('session'), [])

  const [capturedUri, setCapturedUri] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [status, setStatus] = useState('idle')
  const [events, setEvents] = useState<AppEvent[]>([])
  const [realtimeTranscript, setRealtimeTranscript] = useState('')
  const [transcriptHistory, setTranscriptHistory] = useState<{ responseId: string; text: string }[]>([])
  const [cameraReady, setCameraReady] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [visualState, setVisualState] = useState<VisualSessionState>({
    activeTurnId: null,
    activeSnapshotId: null,
    correlationId: null,
    captureState: 'idle',
    analysisState: 'idle',
    lastAnalysisStatus: 'idle',
  })

  const visualStateRef = useRef<VisualSessionState>(visualState)
  const snapshotBufferRef = useRef<BufferedSnapshot[]>([])
  const pendingCallsRef = useRef<Map<string, PendingToolCall>>(new Map())
  const lastCaptureTriggerRef = useRef(0)
  const intentDedupRef = useRef<Record<string, number>>({})
  const isCapturingRef = useRef(false)
  const handleIntentFromTranscriptRef = useRef<(text: string, source: string) => void>(() => {})
  const handleToolCallRef = useRef<(name: string, callId: string, args: Record<string, unknown>) => void>(() => {})

  useEffect(() => {
    visualStateRef.current = visualState
  }, [visualState])

  const addEvent = useCallback((event: AppEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, RECENT_EVENTS_LIMIT))
  }, [])

  const pushTranscriptHistory = useCallback((entry: { responseId: string; text: string }) => {
    setTranscriptHistory((prev) => {
      const head = prev[0]
      if (head?.responseId === entry.responseId && head?.text === entry.text) return prev
      return [entry, ...prev].slice(0, 20)
    })
  }, [])

  const prunePendingCalls = useCallback(() => {
    const now = Date.now()
    for (const [callId, call] of pendingCallsRef.current.entries()) {
      if (now - call.createdAt > TOOL_RESULT_TTL_MS) {
        pendingCallsRef.current.delete(callId)
      }
    }
  }, [])

  const registerPendingCall = useCallback((call: PendingToolCall) => {
    prunePendingCalls()
    pendingCallsRef.current.set(call.callId, call)
  }, [prunePendingCalls])

  const updatePendingCall = useCallback((callId: string, patch: Partial<PendingToolCall>) => {
    const existing = pendingCallsRef.current.get(callId)
    if (!existing) return
    pendingCallsRef.current.set(callId, { ...existing, ...patch })
  }, [])

  const clearPendingCall = useCallback((callId: string) => {
    pendingCallsRef.current.delete(callId)
  }, [])

  const findPendingAnalyzeCall = useCallback((snapshotId?: string | null, turnId?: string | null) => {
    prunePendingCalls()
    for (const call of pendingCallsRef.current.values()) {
      if (call.name !== 'analyze_plant_snapshot') continue
      if (snapshotId && call.snapshotId === snapshotId) return call
      if (turnId && call.turnId === turnId) return call
    }
    return null
  }, [prunePendingCalls])

  const { cameraRef, facing, hasPermission, requestPermission, takePhoto } = useCamera()

  const rememberSnapshot = useCallback((snapshot: BufferedSnapshot) => {
    snapshotBufferRef.current = [snapshot, ...snapshotBufferRef.current.filter((item) => item.snapshotId !== snapshot.snapshotId)]
      .slice(0, SNAPSHOT_BUFFER_LIMIT)
    setCapturedUri(snapshot.uri)
  }, [])

  const getSnapshotById = useCallback((snapshotId?: string | null) => {
    if (!snapshotId) return null
    return snapshotBufferRef.current.find((snapshot) => snapshot.snapshotId === snapshotId) || null
  }, [])

  const getFreshBufferedSnapshot = useCallback((captureMode: CaptureMode, framingHint?: FramingHint) => {
    if (captureMode !== 'latest_buffered') return null
    const snapshot = snapshotBufferRef.current[0]
    if (!snapshot) return null
    const ageMs = Date.now() - snapshot.captureTs
    if (ageMs > SNAPSHOT_BUFFER_FRESHNESS_MS) return null
    if (framingHint && snapshot.framingHint && framingHint !== snapshot.framingHint) return null
    return snapshot
  }, [])

  const postVisualEvent = useCallback(async (
    type: string,
    payload: Record<string, unknown>,
    ids: {
      correlationId: string
      causationId: string
      snapshotId?: string
      turnId?: string
    },
  ) => {
    await postEvent(buildEnvelope(
      type,
      sessionId,
      payload,
      ids.correlationId,
      ids.causationId,
      ids.snapshotId,
      ids.turnId,
    ))
  }, [sessionId])

  const realtime = useRealtime({
    onTranscriptDelta: setRealtimeTranscript,
    onTranscriptDone: (responseId, text) => {
      dlog('UI', 'AI transcript done:', text.slice(0, 120))
      setRealtimeTranscript(text)
      pushTranscriptHistory({ responseId, text })
    },
    onUserTranscript: (text) => {
      dlog('UI', 'user transcript:', text)
      pushTranscriptHistory({ responseId: `user-${Date.now()}`, text })
      handleIntentFromTranscriptRef.current(text, 'realtime_user_audio')
    },
    onToolCall: (name, callId, args) => {
      dlog('UI', 'tool call received:', name, callId, JSON.stringify(args))
      handleToolCallRef.current(name, callId, args)
    },
    onEvent: (ev) => {
      dlog('EV', (ev.type as string) || 'unknown', JSON.stringify(ev).slice(0, 200))
      addEvent(ev)
    },
  })

  const completeToolCall = useCallback((callId: string, payload: Record<string, unknown>) => {
    realtime.sendFunctionResult(callId, payload)
    clearPendingCall(callId)
  }, [clearPendingCall, realtime])

  const rejectToolCall = useCallback((callId: string, reasonCode: string, extras: Record<string, unknown> = {}) => {
    completeToolCall(callId, {
      schemaVersion: '2.0',
      status: 'rejected',
      reasonCode,
      ...extras,
    })
  }, [completeToolCall])

  const runCapture = useCallback(async ({
    turnId,
    snapshotId,
    correlationId,
    causationId,
    captureMode,
    framingHint,
    reason,
    source,
  }: {
    turnId: string
    snapshotId: string
    correlationId: string
    causationId: string
    captureMode: CaptureMode
    framingHint?: FramingHint
    reason: string
    source: string
  }) => {
    if (!cameraReady) {
      setVisualState((prev) => ({
        ...prev,
        activeTurnId: turnId,
        activeSnapshotId: snapshotId,
        correlationId,
        captureState: 'failed',
      }))
      setStatus('camera not ready')
      await postVisualEvent('capture.rejected', { reasonCode: 'camera_not_ready', source }, { correlationId, causationId, snapshotId, turnId })
      return {
        status: 'rejected' as const,
        reasonCode: 'camera_not_ready',
      }
    }

    if (isCapturingRef.current) {
      await postVisualEvent('capture.rejected', { reasonCode: 'camera_busy', source }, { correlationId, causationId, snapshotId, turnId })
      return {
        status: 'rejected' as const,
        reasonCode: 'camera_busy',
      }
    }

    isCapturingRef.current = true
    setIsAnalyzing(true)
    setVisualState((prev) => ({
      ...prev,
      activeTurnId: turnId,
      activeSnapshotId: snapshotId,
      correlationId,
      captureState: 'awaiting_capture',
    }))

    await postVisualEvent('capture.accepted', {
      captureMode,
      framingHint,
      reason,
      cameraState: 'ready',
      source,
    }, { correlationId, causationId, snapshotId, turnId })

    try {
      const buffered = getFreshBufferedSnapshot(captureMode, framingHint)
      const uri = buffered?.uri || await takePhoto()
      if (!uri) {
        setVisualState((prev) => ({ ...prev, captureState: 'failed' }))
        await postVisualEvent('capture.rejected', { reasonCode: 'capture_failed', source }, { correlationId, causationId, snapshotId, turnId })
        return {
          status: 'rejected' as const,
          reasonCode: 'capture_failed',
        }
      }

      const snapshot: BufferedSnapshot = {
        snapshotId,
        turnId,
        correlationId,
        uri,
        captureTs: buffered?.captureTs || Date.now(),
        framingHint,
      }
      rememberSnapshot(snapshot)
      setStatus(buffered ? 'using buffered snapshot' : 'snapshot captured')
      setVisualState((prev) => ({
        ...prev,
        activeTurnId: turnId,
        activeSnapshotId: snapshotId,
        correlationId,
        captureState: 'captured',
      }))

      await postVisualEvent('snapshot.available', {
        snapshotId,
        source: buffered ? 'buffer' : 'camera',
        captureTs: new Date(snapshot.captureTs).toISOString(),
        freshnessMs: Date.now() - snapshot.captureTs,
        framingHint: framingHint || null,
        localAssetRef: uri,
      }, { correlationId, causationId, snapshotId, turnId })

      return {
        status: 'accepted' as const,
        snapshotId,
        turnId,
        correlationId,
        captureMode: buffered ? 'latest_buffered' : 'fresh_photo',
        framingHint: framingHint || null,
        freshnessMs: Date.now() - snapshot.captureTs,
      }
    } finally {
      isCapturingRef.current = false
      setIsAnalyzing(false)
    }
  }, [cameraReady, getFreshBufferedSnapshot, postVisualEvent, rememberSnapshot, takePhoto])

  const runAnalysis = useCallback(async ({
    snapshot,
    callId,
    analysisGoal,
    summaryMode,
  }: {
    snapshot: BufferedSnapshot
    callId?: string
    analysisGoal: AnalysisGoal
    summaryMode?: boolean
  }) => {
    setIsAnalyzing(true)
    setStatus(`analyzing ${analysisGoal}`)
    setVisualState((prev) => ({
      ...prev,
      activeTurnId: snapshot.turnId,
      activeSnapshotId: snapshot.snapshotId,
      correlationId: snapshot.correlationId,
      analysisState: 'analyzing',
      lastAnalysisStatus: 'pending',
    }))

    if (callId) {
      updatePendingCall(callId, {
        turnId: snapshot.turnId,
        snapshotId: snapshot.snapshotId,
        analysisGoal,
      })
    }

    try {
      const result = await uploadImageForAnalysis(
        snapshot.uri,
        sessionId,
        snapshot.correlationId,
        callId || createId('cause'),
        {
          snapshotId: snapshot.snapshotId,
          turnId: snapshot.turnId,
          toolCallId: callId,
          analysisGoal,
        },
      )
      setAnalysis(result)
      setStatus('analysis received')
      setVisualState((prev) => ({
        ...prev,
        activeTurnId: snapshot.turnId,
        activeSnapshotId: snapshot.snapshotId,
        correlationId: snapshot.correlationId,
        analysisState: 'completed',
        lastAnalysisStatus: 'completed',
      }))

      const payload = {
        schemaVersion: '2.0',
        status: 'completed',
        snapshotId: snapshot.snapshotId,
        turnId: snapshot.turnId,
        correlationId: snapshot.correlationId,
        analysis: result,
      }

      if (callId) {
        completeToolCall(callId, payload)
      } else if (summaryMode) {
        realtime.sendSystemEventSummary('Visual analysis completed.', payload)
      }
      return result
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(`analysis error: ${message}`)
      setVisualState((prev) => ({
        ...prev,
        analysisState: 'failed',
        lastAnalysisStatus: 'failed',
      }))
      if (callId) {
        completeToolCall(callId, {
          schemaVersion: '2.0',
          status: 'failed',
          snapshotId: snapshot.snapshotId,
          turnId: snapshot.turnId,
          correlationId: snapshot.correlationId,
          error: message,
        })
      } else if (summaryMode) {
        realtime.sendSystemEventSummary('Visual analysis failed.', {
          snapshotId: snapshot.snapshotId,
          turnId: snapshot.turnId,
          correlationId: snapshot.correlationId,
          error: message,
        })
      }
      return null
    } finally {
      setIsAnalyzing(false)
    }
  }, [completeToolCall, realtime, sessionId, updatePendingCall])

  const handleRequestPlantSnapshot = useCallback(async (callId: string, args: Record<string, unknown>) => {
    const reason = typeof args.reason === 'string' ? args.reason : 'visual inspection'
    const captureMode = args.capture_mode === 'fresh_photo' ? 'fresh_photo' : 'latest_buffered'
    const framingHint = typeof args.framing_hint === 'string' ? args.framing_hint as FramingHint : undefined
    const current = visualStateRef.current
    const currentSnapshot = getSnapshotById(current.activeSnapshotId)

    if ((current.captureState === 'awaiting_capture' || current.analysisState === 'analyzing') && currentSnapshot) {
      completeToolCall(callId, {
        schemaVersion: '2.0',
        status: 'accepted',
        snapshotId: currentSnapshot.snapshotId,
        turnId: currentSnapshot.turnId,
        correlationId: currentSnapshot.correlationId,
        captureMode: 'latest_buffered',
        framingHint: currentSnapshot.framingHint || null,
        freshnessMs: Date.now() - currentSnapshot.captureTs,
        reused: true,
      })
      return
    }

    const turnId = createId('turn')
    const snapshotId = createId('snap')
    const correlationId = createId('corr')
    registerPendingCall({
      callId,
      name: 'request_plant_snapshot',
      turnId,
      snapshotId,
      correlationId,
      createdAt: Date.now(),
    })

    const result = await runCapture({
      turnId,
      snapshotId,
      correlationId,
      causationId: callId,
      captureMode,
      framingHint,
      reason,
      source: 'tool:request_plant_snapshot',
    })

    if (result.status === 'accepted') {
      completeToolCall(callId, {
        schemaVersion: '2.0',
        ...result,
      })
      return
    }

    rejectToolCall(callId, result.reasonCode, {
      correlationId,
      snapshotId,
      turnId,
    })
  }, [completeToolCall, getSnapshotById, registerPendingCall, rejectToolCall, runCapture])

  const handleAnalyzePlantSnapshot = useCallback(async (callId: string, args: Record<string, unknown>) => {
    const snapshotId = typeof args.snapshotId === 'string' ? args.snapshotId : null
    const analysisGoal = typeof args.analysis_goal === 'string' ? args.analysis_goal as AnalysisGoal : null

    if (!snapshotId || !analysisGoal) {
      rejectToolCall(callId, 'invalid_arguments')
      return
    }

    const snapshot = getSnapshotById(snapshotId)
    if (!snapshot) {
      rejectToolCall(callId, 'snapshot_missing', { snapshotId })
      return
    }

    registerPendingCall({
      callId,
      name: 'analyze_plant_snapshot',
      turnId: snapshot.turnId,
      snapshotId: snapshot.snapshotId,
      correlationId: snapshot.correlationId,
      analysisGoal,
      createdAt: Date.now(),
    })

    await runAnalysis({
      snapshot,
      callId,
      analysisGoal,
    })
  }, [getSnapshotById, registerPendingCall, rejectToolCall, runAnalysis])

  const handleGetVisualContext = useCallback((callId: string) => {
    const snapshot = getSnapshotById(visualStateRef.current.activeSnapshotId)
    completeToolCall(callId, {
      schemaVersion: '2.0',
      cameraReady,
      captureState: visualStateRef.current.captureState,
      analysisState: visualStateRef.current.analysisState,
      activeSnapshotId: visualStateRef.current.activeSnapshotId,
      activeTurnId: visualStateRef.current.activeTurnId,
      snapshotAgeMs: snapshot ? Date.now() - snapshot.captureTs : null,
      lastAnalysisStatus: visualStateRef.current.lastAnalysisStatus,
    })
  }, [cameraReady, completeToolCall, getSnapshotById])

  const handleRequestReframe = useCallback(async (callId: string, args: Record<string, unknown>) => {
    const reason = typeof args.reason === 'string' ? args.reason : 'need another angle'
    const framingHint = typeof args.framing_hint === 'string' ? args.framing_hint as FramingHint : undefined
    const baseSnapshotId = typeof args.snapshotId === 'string' ? args.snapshotId : visualStateRef.current.activeSnapshotId
    const baseSnapshot = getSnapshotById(baseSnapshotId)
    const turnId = baseSnapshot?.turnId || visualStateRef.current.activeTurnId || createId('turn')
    const correlationId = baseSnapshot?.correlationId || visualStateRef.current.correlationId || createId('corr')
    const snapshotId = createId('snap')

    registerPendingCall({
      callId,
      name: 'request_reframe',
      turnId,
      snapshotId,
      correlationId,
      createdAt: Date.now(),
    })

    const result = await runCapture({
      turnId,
      snapshotId,
      correlationId,
      causationId: callId,
      captureMode: 'fresh_photo',
      framingHint,
      reason,
      source: 'tool:request_reframe',
    })

    if (result.status === 'accepted') {
      completeToolCall(callId, {
        schemaVersion: '2.0',
        ...result,
        previousSnapshotId: baseSnapshotId || null,
      })
      return
    }

    rejectToolCall(callId, result.reasonCode, {
      correlationId,
      snapshotId,
      turnId,
      previousSnapshotId: baseSnapshotId || null,
    })
  }, [completeToolCall, getSnapshotById, registerPendingCall, rejectToolCall, runCapture])

  const handleToolCall = useCallback(async (
    name: string,
    callId: string,
    args: Record<string, unknown>,
  ) => {
    addEvent({ type: 'tool_call.started', payload: { name, callId, args } })

    if (name === 'request_plant_snapshot') {
      await handleRequestPlantSnapshot(callId, args)
      return
    }
    if (name === 'analyze_plant_snapshot') {
      await handleAnalyzePlantSnapshot(callId, args)
      return
    }
    if (name === 'get_visual_context') {
      handleGetVisualContext(callId)
      return
    }
    if (name === 'request_reframe') {
      await handleRequestReframe(callId, args)
      return
    }

    rejectToolCall(callId, 'unsupported_tool', { name })
  }, [
    addEvent,
    handleAnalyzePlantSnapshot,
    handleGetVisualContext,
    handleRequestPlantSnapshot,
    handleRequestReframe,
    rejectToolCall,
  ])

  const runAutonomousVisualTurn = useCallback(async (reason: string, analysisGoal: AnalysisGoal, source: string) => {
    const turnId = createId('turn')
    const snapshotId = createId('snap')
    const correlationId = createId('corr')

    const capture = await runCapture({
      turnId,
      snapshotId,
      correlationId,
      causationId: createId('cause'),
      captureMode: 'fresh_photo',
      framingHint: analysisGoal === 'identify' ? 'whole_plant' : 'problem_area',
      reason,
      source,
    })

    if (capture.status !== 'accepted') {
      realtime.sendSystemEventSummary('Visual capture was rejected.', {
        reasonCode: capture.reasonCode,
        source,
      })
      return
    }

    const snapshot = getSnapshotById(snapshotId)
    if (!snapshot) return
    await runAnalysis({ snapshot, analysisGoal, summaryMode: true })
  }, [getSnapshotById, realtime, runAnalysis, runCapture])

  const maybeTriggerCapture = useCallback((reason: string, analysisGoal: AnalysisGoal, source: string) => {
    const now = Date.now()
    if (now - lastCaptureTriggerRef.current < LOCAL_CAPTURE_COOLDOWN_MS) {
      addEvent({ type: 'capture.local.skipped.cooldown', payload: { reason } })
      return
    }
    lastCaptureTriggerRef.current = now
    addEvent({ type: 'capture.local.triggered', payload: { reason } })
    runAutonomousVisualTurn(reason, analysisGoal, source).catch((err: unknown) => {
      setStatus('auto visual error: ' + (err instanceof Error ? err.message : String(err)))
    })
  }, [addEvent, runAutonomousVisualTurn])

  const handleIntentFromTranscript = useCallback((text: string, source: string) => {
    const inferred = inferIntentFromText(text)
    if (!inferred) {
      addEvent({ type: 'intent.no_match', payload: { source, text } })
      return
    }

    const dedupKey = `${sessionId}:${source}:${inferred.intent}`
    const lastTs = intentDedupRef.current[dedupKey] || 0
    if (Date.now() - lastTs <= INTENT_DEDUP_TTL_MS) return
    intentDedupRef.current[dedupKey] = Date.now()

    const envelope = buildEnvelope('intent.detected', sessionId, {
      intent: inferred.intent,
      confidence: inferred.confidence,
      transcriptText: text,
      source,
    })
    addEvent({ type: 'intent.inferred', payload: { source, intent: inferred.intent, confidence: inferred.confidence, text } })
    postEvent(envelope).catch(() => {})

    const analysisGoal = normalizeAnalysisGoal(inferred.intent)
    if (analysisGoal) {
      maybeTriggerCapture(`intent:${inferred.intent}:${source}`, analysisGoal, `intent:${source}`)
    }
  }, [addEvent, maybeTriggerCapture, sessionId])

  handleIntentFromTranscriptRef.current = handleIntentFromTranscript
  handleToolCallRef.current = handleToolCall

  const handleWsMessage = useCallback((msg: Record<string, unknown>) => {
    addEvent(msg)
    const type = msg.type as string | undefined
    const payload = (msg.payload as Record<string, unknown>) || {}
    const snapshotId = typeof msg.snapshotId === 'string' ? msg.snapshotId : (typeof payload.snapshotId === 'string' ? payload.snapshotId : null)
    const turnId = typeof msg.turnId === 'string' ? msg.turnId : null

    if (type === 'analysis.completed') {
      const pending = findPendingAnalyzeCall(snapshotId, turnId)
      if (pending) {
        setAnalysis(payload as unknown as AnalysisResult)
        setStatus('analysis completed via ws')
        setVisualState((prev) => ({
          ...prev,
          analysisState: 'completed',
          lastAnalysisStatus: 'completed',
        }))
        completeToolCall(pending.callId, {
          schemaVersion: '2.0',
          status: 'completed',
          snapshotId: snapshotId || pending.snapshotId || null,
          turnId: turnId || pending.turnId || null,
          correlationId: pending.correlationId,
          analysis: payload,
        })
      }
      return
    }

    if (type === 'analysis.failed') {
      const pending = findPendingAnalyzeCall(snapshotId, turnId)
      setStatus(`analysis failed: ${payload.error || 'unknown'}`)
      setVisualState((prev) => ({
        ...prev,
        analysisState: 'failed',
        lastAnalysisStatus: 'failed',
      }))
      if (pending) {
        completeToolCall(pending.callId, {
          schemaVersion: '2.0',
          status: 'failed',
          snapshotId: snapshotId || pending.snapshotId || null,
          turnId: turnId || pending.turnId || null,
          correlationId: pending.correlationId,
          error: payload.error || 'unknown',
        })
      }
      return
    }

    if (type === 'capture.requested') {
      const goal = payload.reason === 'intent:identify_plant' ? 'identify' : 'diagnose'
      maybeTriggerCapture(
        'orchestrator:capture.requested',
        goal,
        'ws:capture.requested',
      )
      return
    }

    if (type === 'capture.accepted') {
      setStatus('capture accepted by orchestrator')
      return
    }

    if (type === 'capture.rejected') {
      setStatus(`capture rejected: ${payload.reasonCode || 'unknown'}`)
      return
    }

    if (type === 'assistant.prompt') {
      const promptText = (payload.text as string) || 'Please provide a clearer plant image.'
      setStatus(`assistant prompt: ${promptText}`)
      realtime.sendText(promptText)
      return
    }

    if (type === 'assistant.visual_guidance') {
      const guidance = (payload.text as string) || 'Try a different angle.'
      setStatus(`visual guidance: ${guidance}`)
      realtime.sendSystemEventSummary(guidance, { reasonCode: payload.reasonCode || null })
    }
  }, [addEvent, completeToolCall, findPendingAnalyzeCall, maybeTriggerCapture, realtime])

  const ws = useWebSocket({ sessionId, onMessage: handleWsMessage })

  useEffect(() => {
    dlog('APP', '=== mount, session:', sessionId, '===')
    ws.connect()
    realtime.start()
    return () => {
      realtime.stop()
      ws.disconnect()
    }
  }, [])

  useEffect(() => {
    dlog('APP', 'realtime connected:', realtime.connected, 'status:', realtime.status)
  }, [realtime.connected, realtime.status])

  useEffect(() => {
    dlog('APP', 'ws connected:', ws.connected)
  }, [ws.connected])

  const handleCaptureAndSend = useCallback(async () => {
    const turnId = createId('turn')
    const snapshotId = createId('snap')
    const correlationId = createId('corr')
    const capture = await runCapture({
      turnId,
      snapshotId,
      correlationId,
      causationId: createId('cause'),
      captureMode: 'fresh_photo',
      framingHint: 'whole_plant',
      reason: 'manual_capture',
      source: 'manual_button',
    })

    if (capture.status !== 'accepted') {
      setStatus(`capture failed: ${capture.reasonCode}`)
      return
    }

    const snapshot = getSnapshotById(snapshotId)
    if (!snapshot) {
      setStatus('capture failed: missing snapshot')
      return
    }
    await runAnalysis({ snapshot, analysisGoal: 'diagnose', summaryMode: true })
  }, [getSnapshotById, runAnalysis, runCapture])

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.permText}>Нужен доступ к камере</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Разрешить</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>GardenAI</Text>
        <Text style={styles.meta}>session: {sessionId.slice(0, 20)}…</Text>

        {/* Camera */}
        <View style={styles.cameraContainer}>
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing={facing}
            onCameraReady={() => setCameraReady(true)}
          />
          {isAnalyzing && (
            <View style={styles.analyzingOverlay}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.analyzingText}>Алекс смотрит…</Text>
            </View>
          )}
        </View>

        {/* Controls */}
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.btn, !cameraReady && styles.btnDisabled]}
            onPress={handleCaptureAndSend}
            disabled={!cameraReady}
          >
            <Text style={styles.btnText}>{cameraReady ? 'Снять и отправить' : 'Камера инициализируется…'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.btn, ws.connected && styles.btnActive]}
            onPress={ws.connected ? ws.disconnect : ws.connect}
          >
            <Text style={styles.btnText}>WS {ws.connected ? 'Disconnect' : 'Connect'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, realtime.connected && styles.btnActive]}
            onPress={realtime.connected ? realtime.stop : realtime.start}
          >
            <Text style={styles.btnText}>Realtime {realtime.connected ? 'Stop' : 'Start'}</Text>
          </TouchableOpacity>
        </View>

        {/* Status */}
        <View style={styles.section}>
          <Text style={styles.label}>Статус: <Text style={styles.value}>{status || realtime.status}</Text></Text>
          <Text style={styles.label}>WS: <Text style={styles.value}>{ws.connected ? 'connected' : 'disconnected'}</Text></Text>
          <Text style={styles.label}>Realtime: <Text style={styles.value}>{realtime.connected ? 'connected' : 'disconnected'}</Text></Text>
          <Text style={styles.label}>Turn: <Text style={styles.value}>{visualState.activeTurnId || 'none'}</Text></Text>
          <Text style={styles.label}>Snapshot: <Text style={styles.value}>{visualState.activeSnapshotId || 'none'}</Text></Text>
          <Text style={styles.label}>Capture: <Text style={styles.value}>{visualState.captureState}</Text></Text>
          <Text style={styles.label}>Analysis: <Text style={styles.value}>{visualState.analysisState}</Text></Text>
        </View>

        {/* Captured photo */}
        {capturedUri && (
          <View style={styles.section}>
            <Text style={styles.label}>Снимок:</Text>
            <Image source={{ uri: capturedUri }} style={styles.capture} />
          </View>
        )}

        {/* Transcript */}
        <View style={styles.section}>
          <Text style={styles.label}>Ассистент:</Text>
          <Text style={styles.pre}>{realtimeTranscript || '…'}</Text>
        </View>

        {/* User transcript history */}
        <View style={styles.section}>
          <Text style={styles.label}>История ({transcriptHistory.length}):</Text>
          {transcriptHistory.slice(0, 6).map((entry) => {
            const isUser = entry.responseId.startsWith('user-')
            return (
              <Text
                key={entry.responseId}
                style={[styles.pre, { marginTop: 2, color: isUser ? '#1a5276' : '#1e8449' }]}
              >
                {isUser ? '🎤 ' : '🤖 '}{entry.text}
              </Text>
            )
          })}
        </View>

        {/* Analysis */}
        {analysis && (
          <View style={styles.section}>
            <Text style={styles.label}>Анализ:</Text>
            <Text style={styles.pre}>{JSON.stringify(analysis, null, 2)}</Text>
          </View>
        )}

        {/* Events */}
        <View style={styles.section}>
          <Text style={styles.label}>События ({events.length}):</Text>
          <Text style={styles.pre}>{JSON.stringify(events.slice(0, 5), null, 2)}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  meta: { fontSize: 11, color: '#888', marginBottom: 12 },
  cameraContainer: { width: '100%', height: 280, borderRadius: 8, overflow: 'hidden', marginBottom: 12 },
  camera: { width: '100%', height: 280, backgroundColor: '#000' },
  analyzingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  analyzingText: { color: '#fff', marginTop: 12, fontSize: 16, fontWeight: '600', letterSpacing: 0.3 },
  capture: { width: '100%', height: 200, borderRadius: 8, resizeMode: 'contain', marginTop: 8 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  btn: { flex: 1, backgroundColor: '#2d6a4f', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnActive: { backgroundColor: '#1b4332' },
  btnDisabled: { backgroundColor: '#aaa' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  permText: { fontSize: 16, marginBottom: 16, textAlign: 'center' },
  section: { marginTop: 16 },
  label: { fontSize: 13, fontWeight: '600', color: '#333' },
  value: { fontWeight: '400', color: '#555' },
  pre: { fontFamily: 'monospace', fontSize: 11, color: '#333', marginTop: 4, backgroundColor: '#f5f5f5', padding: 8, borderRadius: 6 },
})
