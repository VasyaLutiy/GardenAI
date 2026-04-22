const test = require('node:test')
const assert = require('node:assert/strict')

process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com'
process.env.AZURE_OPENAI_API_KEY = 'test-key'
process.env.AZURE_OPENAI_VISION_DEPLOYMENT = 'vision-test'

const { processVisionCommand } = require('../index')

function createClient() {
  const calls = []
  return {
    calls,
    async get(key) {
      calls.push(['get', key])
      return 'data:image/jpeg;base64,abc123'
    },
    async xAdd(...args) {
      calls.push(['xAdd', ...args])
    },
    async publish(...args) {
      calls.push(['publish', ...args])
    },
    async set(...args) {
      calls.push(['set', ...args])
    },
    async del(...args) {
      calls.push(['del', ...args])
    }
  }
}

test('processVisionCommand publishes analysis.completed into session stream with visual ids', async () => {
  const client = createClient()
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                species: 'Rose',
                confidence: 0.91,
                diagnoses: ['healthy'],
                suggestions: ['continue current watering'],
                urgency: 'low',
                disclaimer: 'AI guidance only'
              })
            }
          }
        ]
      }
    }
  })

  try {
    await processVisionCommand(client, {
      messageId: 'msg-success',
      sessionId: 'session-success',
      correlationId: 'corr-success',
      turnId: 'turn-success',
      snapshotId: 'snap-success',
      schemaVersion: '2.0',
      payload: {
        imageArtifactKey: 'artifact:image:msg-success',
        replyKey: 'analysis:reply:msg-success',
        toolCallId: 'call-success',
        analysisGoal: 'diagnose',
        attempt: 1
      }
    })
  } finally {
    global.fetch = originalFetch
  }

  const analysisResultAdd = client.calls.find((call) => call[0] === 'xAdd' && call[1] === 'stream:analysis-results')
  const sessionEventAdd = client.calls.find((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  assert.ok(analysisResultAdd)
  assert.ok(sessionEventAdd)

  const publishedEvent = JSON.parse(sessionEventAdd[3].payload)
  assert.equal(publishedEvent.type, 'analysis.completed')
  assert.equal(publishedEvent.turnId, 'turn-success')
  assert.equal(publishedEvent.snapshotId, 'snap-success')
  assert.equal(publishedEvent.correlationId, 'corr-success')
  assert.equal(publishedEvent.toolCallId, 'call-success')
  assert.equal(publishedEvent.payload.species, 'Rose')
})

test('processVisionCommand requeues on transient failure without deleting the artifact', async () => {
  const client = createClient()
  const originalFetch = global.fetch
  global.fetch = async () => {
    throw new Error('transient vision failure')
  }

  try {
    await processVisionCommand(client, {
      messageId: 'msg-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
      payload: {
        imageArtifactKey: 'artifact:image:msg-1',
        replyKey: 'analysis:reply:msg-1',
        toolCallId: 'call-1',
        analysisGoal: 'diagnose',
        turnId: 'turn-1',
        snapshotId: 'snap-1',
        attempt: 1
      }
    })
  } finally {
    global.fetch = originalFetch
  }

  assert.deepEqual(
    client.calls.map((call) => call[0]),
    ['get', 'xAdd']
  )
  const retryCall = client.calls.find((call) => call[0] === 'xAdd')
  assert.equal(retryCall[1], 'stream:vision-commands')
  assert.equal(retryCall[2], '*')
  const retriedEvent = JSON.parse(retryCall[3].payload)
  assert.equal(retriedEvent.messageId, 'msg-1')
  assert.equal(retriedEvent.correlationId, 'corr-1')
  assert.equal(retriedEvent.payload.turnId, 'turn-1')
  assert.equal(retriedEvent.payload.snapshotId, 'snap-1')
  assert.equal(retriedEvent.payload.imageArtifactKey, 'artifact:image:msg-1')
  assert.equal(retriedEvent.payload.replyKey, 'analysis:reply:msg-1')
  assert.equal(retriedEvent.payload.toolCallId, 'call-1')
  assert.equal(retriedEvent.payload.attempt, 2)
  assert.equal(client.calls.some((call) => call[0] === 'del'), false)
})

test('processVisionCommand deletes the artifact after terminal failure', async () => {
  const client = createClient()
  const originalFetch = global.fetch
  global.fetch = async () => {
    throw new Error('terminal vision failure')
  }

  try {
    await processVisionCommand(client, {
      messageId: 'msg-2',
      sessionId: 'session-2',
      correlationId: 'corr-2',
      payload: {
        imageArtifactKey: 'artifact:image:msg-2',
        replyKey: 'analysis:reply:msg-2',
        toolCallId: 'call-2',
        analysisGoal: 'diagnose',
        turnId: 'turn-2',
        snapshotId: 'snap-2',
        attempt: 3
      }
    })
  } finally {
    global.fetch = originalFetch
  }

  assert.equal(client.calls.some((call) => call[0] === 'xAdd' && call[1] === 'stream:vision-commands'), false)
  assert.equal(client.calls.some((call) => call[0] === 'xAdd' && call[1] === 'stream:analysis-results'), true)
  assert.equal(client.calls.some((call) => call[0] === 'xAdd' && call[1] === 'stream:dlq'), true)
  assert.equal(client.calls.some((call) => call[0] === 'del' && call[1] === 'artifact:image:msg-2'), true)
  assert.equal(client.calls.some((call) => call[0] === 'set' && call[1] === 'analysis:reply:msg-2'), true)

  const analysisResultAdd = client.calls.find(
    (call) => call[0] === 'xAdd' && call[1] === 'stream:analysis-results'
  )
  const failedResult = JSON.parse(analysisResultAdd[3].payload)
  assert.equal(failedResult.correlationId, 'corr-2')
  assert.equal(failedResult.turnId, 'turn-2')
  assert.equal(failedResult.snapshotId, 'snap-2')
  assert.equal(failedResult.toolCallId, 'call-2')
})
