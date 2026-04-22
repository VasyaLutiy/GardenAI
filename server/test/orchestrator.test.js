const test = require('node:test')
const assert = require('node:assert/strict')

const { processOrchestratorMessage } = require('../index')

function createClient(initialState = null) {
  const calls = []
  const state = new Map()
  if (initialState) {
    state.set('state:session-visual:session-1', JSON.stringify(initialState))
  }

  return {
    calls,
    state,
    async get(key) {
      calls.push(['get', key])
      return state.get(key) || null
    },
    async set(key, value, options) {
      calls.push(['set', key, value, options])
      if (options?.NX && state.has(key)) {
        return null
      }
      state.set(key, value)
      return 'OK'
    },
    async xAdd(...args) {
      calls.push(['xAdd', ...args])
      return '1-0'
    },
    async publish(...args) {
      calls.push(['publish', ...args])
      return 1
    },
    async xAck(...args) {
      calls.push(['xAck', ...args])
      return 1
    }
  }
}

test('processOrchestratorMessage publishes analysis.requested from snapshot.uploaded', async () => {
  const client = createClient({
    sessionId: 'session-1',
    activeTurnId: 'turn-prev',
    activeSnapshotId: 'snap-prev',
    analysisGoal: 'identify',
    snapshotState: 'available'
  })

  await processOrchestratorMessage(client, {
    id: '1710000000000-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-uploaded-1',
        type: 'snapshot.uploaded',
        sessionId: 'session-1',
        correlationId: 'corr-1',
        causationId: 'cause-1',
        turnId: 'turn-1',
        snapshotId: 'snap-1',
        tsWallIso: '2026-04-22T12:00:00.000Z',
        schemaVersion: '2.0',
        payload: {
          artifactKey: 'artifact:image:evt-uploaded-1',
          replyKey: 'analysis:reply:evt-uploaded-1',
          toolCallId: 'call-1',
          analysisGoal: 'diagnose'
        }
      })
    }
  })

  const persistedState = JSON.parse(client.state.get('state:session-visual:session-1'))
  assert.equal(persistedState.activeTurnId, 'turn-1')
  assert.equal(persistedState.activeSnapshotId, 'snap-1')
  assert.equal(persistedState.snapshotState, 'uploaded')
  assert.equal(persistedState.analysisGoal, 'diagnose')

  const sessionAdd = client.calls.find((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  assert.ok(sessionAdd)
  const publishedEvent = JSON.parse(sessionAdd[3].payload)
  assert.equal(publishedEvent.type, 'analysis.requested')
  assert.equal(publishedEvent.turnId, 'turn-1')
  assert.equal(publishedEvent.snapshotId, 'snap-1')
  assert.equal(publishedEvent.payload.imageArtifactKey, 'artifact:image:evt-uploaded-1')
  assert.equal(publishedEvent.payload.replyKey, 'analysis:reply:evt-uploaded-1')
  assert.equal(publishedEvent.payload.toolCallId, 'call-1')
  assert.equal(publishedEvent.payload.analysisGoal, 'diagnose')
})

test('processOrchestratorMessage is idempotent for snapshot.uploaded when analysis already requested', async () => {
  const client = createClient({
    sessionId: 'session-1',
    activeTurnId: 'turn-1',
    activeSnapshotId: 'snap-1',
    snapshotState: 'analyzing',
    analysisState: 'requested',
    analysisGoal: 'diagnose',
    lastEventType: 'analysis.requested'
  })
  client.state.set('dedupe:analysis-requested:session-1:snap-1:diagnose', 'evt-uploaded-dupe')

  await processOrchestratorMessage(client, {
    id: '1710000000001-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-uploaded-dupe',
        type: 'snapshot.uploaded',
        sessionId: 'session-1',
        correlationId: 'corr-1',
        causationId: 'cause-1',
        turnId: 'turn-1',
        snapshotId: 'snap-1',
        tsWallIso: '2026-04-22T12:00:01.000Z',
        schemaVersion: '2.0',
        payload: {
          artifactKey: 'artifact:image:evt-uploaded-1',
          replyKey: 'analysis:reply:evt-uploaded-1',
          toolCallId: 'call-1',
          analysisGoal: 'diagnose'
        }
      })
    }
  })

  const sessionAdds = client.calls.filter((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  const publishedTypes = sessionAdds.map((call) => JSON.parse(call[3].payload).type)
  assert.equal(publishedTypes.includes('analysis.requested'), false)
})

test('processOrchestratorMessage sets tool reply context with correlation for analysis.requested', async () => {
  const client = createClient()

  await processOrchestratorMessage(client, {
    id: '1710000000002-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-analysis-req',
        type: 'analysis.requested',
        sessionId: 'session-ctx',
        correlationId: 'corr-ctx',
        causationId: 'cause-ctx',
        turnId: 'turn-ctx',
        snapshotId: 'snap-ctx',
        schemaVersion: '2.0',
        payload: {
          toolCallId: 'call-ctx',
          replyKey: 'analysis:reply:evt-analysis-req',
          analysisGoal: 'identify',
          attempt: 1
        }
      })
    }
  })

  const setCall = client.calls.find((call) => call[0] === 'set' && call[1] === 'reply:tool:call-ctx')
  assert.ok(setCall, 'tool reply context should be persisted')
  const stored = JSON.parse(setCall[2])
  assert.equal(stored.correlationId, 'corr-ctx')
  assert.equal(stored.toolCallId, 'call-ctx')
  assert.equal(stored.snapshotId, 'snap-ctx')
  assert.equal(stored.turnId, 'turn-ctx')
  assert.equal(stored.status, 'pending')
})
