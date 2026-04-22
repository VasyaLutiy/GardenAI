const test = require('node:test')
const assert = require('node:assert/strict')

const { processOrchestratorMessage, getVisualTransitionError } = require('../index')

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

test('processOrchestratorMessage marks late analysis.completed as completed_late and preserves active visual pointers', async () => {
  const client = createClient({
    sessionId: 'session-1',
    activeTurnId: 'turn-new',
    activeSnapshotId: 'snap-new',
    activeCorrelationId: 'corr-new',
    snapshotState: 'analyzing',
    analysisState: 'requested',
    analysisRequestedCorrelationId: 'corr-new',
    analysisRequestedTurnId: 'turn-new',
    analysisRequestedSnapshotId: 'snap-new'
  })
  client.state.set('reply:tool:call-late', JSON.stringify({
    toolCallId: 'call-late',
    sessionId: 'session-1',
    correlationId: 'corr-old',
    turnId: 'turn-old',
    snapshotId: 'snap-old',
    status: 'timeout'
  }))

  await processOrchestratorMessage(client, {
    id: '1710000000002-late',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-analysis-completed-late',
        type: 'analysis.completed',
        sessionId: 'session-1',
        correlationId: 'corr-old',
        causationId: 'cause-old',
        turnId: 'turn-old',
        snapshotId: 'snap-old',
        toolCallId: 'call-late',
        schemaVersion: '2.0',
        payload: { species: 'rose', confidence: 0.8 }
      })
    }
  })

  const visualState = JSON.parse(client.state.get('state:session-visual:session-1'))
  assert.equal(visualState.activeTurnId, 'turn-new')
  assert.equal(visualState.activeSnapshotId, 'snap-new')
  assert.equal(visualState.activeCorrelationId, 'corr-new')
  assert.equal(visualState.lastCompletedTurnId, 'turn-old')
  assert.equal(visualState.lastCompletedSnapshotId, 'snap-old')
  assert.equal(visualState.lastCompletedCorrelationId, 'corr-old')
  assert.equal(visualState.lastCompletedDisposition, 'late')

  const replyContext = JSON.parse(client.state.get('reply:tool:call-late'))
  assert.equal(replyContext.status, 'completed_late')
  assert.equal(replyContext.turnId, 'turn-old')
  assert.equal(replyContext.snapshotId, 'snap-old')
  assert.equal(replyContext.correlationId, 'corr-old')
})

test('processOrchestratorMessage marks capture.rejected as failed for the active turn', async () => {
  const client = createClient({
    sessionId: 'session-1',
    activeTurnId: 'turn-1',
    activeSnapshotId: 'snap-1',
    captureState: 'requested'
  })

  await processOrchestratorMessage(client, {
    id: '1710000000003-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-capture-rejected',
        type: 'capture.rejected',
        sessionId: 'session-1',
        correlationId: 'corr-rejected',
        causationId: 'cause-rejected',
        turnId: 'turn-1',
        snapshotId: 'snap-1',
        tsWallIso: '2026-04-22T12:00:02.000Z',
        schemaVersion: '2.0',
        payload: { reason: 'camera_busy' }
      })
    }
  })

  const persistedState = JSON.parse(client.state.get('state:session-visual:session-1'))
  assert.equal(persistedState.captureState, 'failed')
  assert.equal(persistedState.activeTurnId, 'turn-1')
  assert.equal(persistedState.activeSnapshotId, 'snap-1')
  assert.equal(persistedState.lastEventType, 'capture.rejected')
})

test('processOrchestratorMessage only emits one capture.requested per intent cooldown window', async () => {
  const client = createClient()
  const intentEvent = {
    messageId: 'evt-intent-1',
    type: 'intent.detected',
    sessionId: 'session-1',
    correlationId: 'corr-intent-1',
    causationId: 'cause-intent-1',
    tsWallIso: '2026-04-22T12:00:03.000Z',
    schemaVersion: '2.0',
    payload: { intent: 'diagnose_plant', confidence: 0.93 }
  }

  await processOrchestratorMessage(client, { id: '1710000000004-0', message: { payload: JSON.stringify(intentEvent) } })
  await processOrchestratorMessage(client, { id: '1710000000005-0', message: { payload: JSON.stringify(intentEvent) } })

  const sessionAdds = client.calls.filter((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  const captureRequests = sessionAdds
    .map((call) => JSON.parse(call[3].payload))
    .filter((event) => event.type === 'capture.requested')

  assert.equal(captureRequests.length, 1)
  assert.equal(captureRequests[0].correlationId, 'corr-intent-1')
})

test('processOrchestratorMessage emits capture.requested for reframe.requested with preserved correlation and ids', async () => {
  const client = createClient({
    sessionId: 'session-1',
    activeTurnId: 'turn-prev',
    activeSnapshotId: 'snap-prev',
    analysisGoal: 'identify'
  })

  await processOrchestratorMessage(client, {
    id: '1710000000006-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-reframe-1',
        type: 'reframe.requested',
        sessionId: 'session-1',
        correlationId: 'corr-reframe-1',
        causationId: 'cause-reframe-1',
        turnId: 'turn-reframe',
        snapshotId: 'snap-reframe',
        schemaVersion: '2.0',
        payload: {
          reason: 'need closer view',
          framingHint: 'focus on leaves',
          requestedBy: 'assistant',
          targetSnapshotId: 'snap-prev'
        }
      })
    }
  })

  const captureAdd = client.calls.find((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  assert.ok(captureAdd, 'capture.requested should be published')
  const captureEvent = JSON.parse(captureAdd[3].payload)
  assert.equal(captureEvent.type, 'capture.requested')
  assert.equal(captureEvent.correlationId, 'corr-reframe-1')
  assert.equal(captureEvent.turnId, 'turn-reframe')
  assert.equal(captureEvent.snapshotId, 'snap-reframe')
  assert.equal(captureEvent.payload.analysisGoal, 'identify')
  assert.equal(captureEvent.payload.intention, 'identify')
  assert.equal(captureEvent.payload.targetSnapshotId, 'snap-prev')

  const turnState = JSON.parse(client.state.get('state:turn:turn-reframe'))
  const snapshotState = JSON.parse(client.state.get('state:snapshot:snap-reframe'))
  assert.equal(turnState.turnId, 'turn-reframe')
  assert.equal(turnState.status, 'awaiting_capture')
  assert.equal(snapshotState.snapshotId, 'snap-reframe')
  assert.equal(snapshotState.status, 'requested')
})

test('reframe.requested carries analysisGoal into downstream analysis.requested when upload lacks goal', async () => {
  const client = createClient({
    sessionId: 'session-reframe-goal',
    activeTurnId: 'turn-prev',
    activeSnapshotId: 'snap-prev',
    analysisGoal: 'diagnose'
  })

  const reframeEvent = {
    messageId: 'evt-reframe-goal',
    type: 'reframe.requested',
    sessionId: 'session-reframe-goal',
    correlationId: 'corr-reframe-goal',
    causationId: 'cause-reframe-goal',
    turnId: 'turn-reframe-goal',
    snapshotId: 'snap-reframe-goal',
    schemaVersion: '2.0',
    payload: {
      reason: 'zoom for diagnosis',
      framingHint: 'leaf_closeup',
      requestedBy: 'assistant',
      targetSnapshotId: 'snap-prev',
      analysisGoal: 'care_advice'
    }
  }

  await processOrchestratorMessage(client, { id: '1710000000006-1', message: { payload: JSON.stringify(reframeEvent) } })

  const uploadEvent = {
    messageId: 'evt-upload-after-reframe',
    type: 'snapshot.uploaded',
    sessionId: 'session-reframe-goal',
    correlationId: 'corr-reframe-goal',
    causationId: 'cause-upload-goal',
    turnId: 'turn-reframe-goal',
    snapshotId: 'snap-reframe-goal',
    tsWallIso: '2026-04-22T12:00:05.000Z',
    schemaVersion: '2.0',
    payload: {
      artifactKey: 'artifact:image:evt-upload-after-reframe',
      replyKey: 'analysis:reply:evt-upload-after-reframe',
      toolCallId: 'call-reframe-upload'
    }
  }

  await processOrchestratorMessage(client, { id: '1710000000006-2', message: { payload: JSON.stringify(uploadEvent) } })

  const sessionAdds = client.calls.filter((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  const analysisRequested = sessionAdds
    .map((call) => JSON.parse(call[3].payload))
    .find((evt) => evt.type === 'analysis.requested')

  assert.ok(analysisRequested, 'analysis.requested should be published after upload')
  assert.equal(analysisRequested.payload.analysisGoal, 'care_advice')
  assert.equal(analysisRequested.correlationId, 'corr-reframe-goal')
  assert.equal(analysisRequested.snapshotId, 'snap-reframe-goal')
})

test('processOrchestratorMessage does not duplicate capture.requested for the same reframe correlation', async () => {
  const client = createClient()
  const reframeEvent = {
    messageId: 'evt-reframe-dup',
    type: 'reframe.requested',
    sessionId: 'session-dup',
    correlationId: 'corr-reframe-dup',
    causationId: 'cause-reframe-dup',
    turnId: 'turn-dup',
    snapshotId: 'snap-dup',
    schemaVersion: '2.0',
    payload: {
      reason: 'duplicate test',
      targetSnapshotId: 'snap-target'
    }
  }

  await processOrchestratorMessage(client, { id: '1710000000007-0', message: { payload: JSON.stringify(reframeEvent) } })
  await processOrchestratorMessage(client, { id: '1710000000008-0', message: { payload: JSON.stringify(reframeEvent) } })

  const captureAdds = client.calls.filter((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  const captureEvents = captureAdds.map((call) => JSON.parse(call[3].payload)).filter((evt) => evt.type === 'capture.requested')
  assert.equal(captureEvents.length, 1)
  assert.equal(captureEvents[0].correlationId, 'corr-reframe-dup')
})

test('persistTurnAndSnapshotState reads legacy turn key when turnId changes', async () => {
  const client = createClient()
  client.state.set('state:turn:legacy-session', JSON.stringify({
    turnId: 'legacy-session',
    sessionId: 'legacy-session',
    status: 'awaiting_capture',
    source: 'legacy-mobile'
  }))

  const uploadEvent = {
    messageId: 'evt-legacy-upload',
    type: 'snapshot.uploaded',
    sessionId: 'legacy-session',
    correlationId: 'corr-legacy',
    causationId: 'cause-legacy',
    turnId: 'turn-new',
    snapshotId: 'snap-new',
    schemaVersion: '2.0',
    payload: {
      artifactKey: 'artifact:image:evt-legacy-upload',
      replyKey: 'analysis:reply:evt-legacy-upload',
      toolCallId: 'call-legacy'
    }
  }

  await processOrchestratorMessage(client, { id: '1710000000009-legacy', message: { payload: JSON.stringify(uploadEvent) } })

  const getCalls = client.calls.filter((call) => call[0] === 'get').map((call) => call[1])
  assert.ok(getCalls.includes('state:turn:legacy-session'), 'should check legacy turn key for compatibility')

  const persistedTurn = JSON.parse(client.state.get('state:turn:turn-new'))
  assert.equal(persistedTurn.turnId, 'turn-new')
  assert.equal(persistedTurn.source, 'legacy-mobile')
})

test('processOrchestratorMessage persists turn and snapshot state keys for snapshot.uploaded', async () => {
  const client = createClient()

  await processOrchestratorMessage(client, {
    id: '1710000000009-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-upload-state',
        type: 'snapshot.uploaded',
        sessionId: 'session-state',
        correlationId: 'corr-state',
        causationId: 'cause-state',
        turnId: 'turn-state',
        snapshotId: 'snap-state',
        tsWallIso: '2026-04-22T12:00:04.000Z',
        schemaVersion: '2.0',
        payload: {
          artifactKey: 'artifact:image:evt-upload-state',
          replyKey: 'analysis:reply:evt-upload-state',
          toolCallId: 'call-state',
          analysisGoal: 'diagnose'
        }
      })
    }
  })

  const turnStateRaw = client.state.get('state:turn:turn-state')
  const snapshotStateRaw = client.state.get('state:snapshot:snap-state')
  assert.ok(turnStateRaw, 'turn state should be stored under state:turn:*')
  assert.ok(snapshotStateRaw, 'snapshot state should be stored under state:snapshot:*')

  const turnState = JSON.parse(turnStateRaw)
  const snapshotState = JSON.parse(snapshotStateRaw)
  assert.equal(turnState.turnId, 'turn-state')
  assert.equal(turnState.status, 'snapshot_ready')
  assert.equal(snapshotState.snapshotId, 'snap-state')
  assert.equal(snapshotState.status, 'uploaded')
})

test('getVisualTransitionError blocks stale analysis.completed that does not match active turn/snapshot', () => {
  const state = {
    sessionId: 'session-active',
    activeTurnId: 'turn-new',
    activeSnapshotId: 'snap-new',
    analysisState: 'requested',
    snapshotState: 'analyzing',
    activeCorrelationId: 'corr-new',
    lastCorrelationId: 'corr-new'
  }

  const staleCompletion = {
    type: 'analysis.completed',
    sessionId: 'session-active',
    correlationId: 'corr-old',
    turnId: 'turn-old',
    snapshotId: 'snap-old'
  }

  const err = getVisualTransitionError(state, staleCompletion)
  assert.ok(err)
  assert.equal(err.code, 'turn_mismatch')
  assert.equal(err.status, 409)
})

test('processOrchestratorMessage completes pending analysis after timeout without emitting duplicate completions', async () => {
  const client = createClient()
  client.state.set(
    'state:session-visual:session-timeout',
    JSON.stringify({
      sessionId: 'session-timeout',
      activeTurnId: 'turn-timeout',
      activeSnapshotId: 'snap-timeout',
      analysisState: 'requested',
      snapshotState: 'analyzing',
      analysisRequestedCorrelationId: 'corr-timeout',
      analysisRequestedTurnId: 'turn-timeout',
      analysisRequestedSnapshotId: 'snap-timeout',
      lastToolCallId: 'tool-timeout',
      lastCorrelationId: 'corr-timeout',
      lastEventType: 'analysis.requested'
    })
  )

  await processOrchestratorMessage(client, {
    id: '1710000000010-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-late-complete',
        type: 'analysis.completed',
        sessionId: 'session-timeout',
        correlationId: 'corr-timeout',
        causationId: 'cause-timeout',
        turnId: 'turn-timeout',
        snapshotId: 'snap-timeout',
        tsWallIso: '2026-04-22T12:00:10.000Z',
        schemaVersion: '2.0',
        toolCallId: 'tool-timeout',
        payload: { species: 'Fern' }
      })
    }
  })

  const visualState = JSON.parse(client.state.get('state:session-visual:session-timeout'))
  assert.equal(visualState.analysisState, 'completed')
  assert.equal(visualState.snapshotState, 'completed')
  assert.equal(visualState.lastCompletedCorrelationId, 'corr-timeout')
  assert.equal(visualState.lastEventType, 'analysis.completed')

  const turnState = JSON.parse(client.state.get('state:turn:turn-timeout'))
  const snapshotState = JSON.parse(client.state.get('state:snapshot:snap-timeout'))
  assert.equal(turnState.status, 'completed')
  assert.equal(snapshotState.status, 'completed')

  const replyContext = client.calls.find((call) => call[0] === 'set' && call[1] === 'reply:tool:tool-timeout')
  assert.ok(replyContext, 'tool reply context should be set to completed after late result')
  assert.equal(JSON.parse(replyContext[2]).status, 'completed')

  const sessionAdds = client.calls.filter((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  assert.equal(sessionAdds.length, 0, 'late completion should not emit duplicate session events from orchestrator')
})

test('processOrchestratorMessage upgrades failed analysis to completed when late success arrives', async () => {
  const client = createClient()
  client.state.set(
    'state:session-visual:session-recover',
    JSON.stringify({
      sessionId: 'session-recover',
      activeTurnId: 'turn-recover',
      activeSnapshotId: 'snap-recover',
      analysisState: 'failed',
      snapshotState: 'failed',
      lastFailedCorrelationId: 'corr-recover',
      lastFailedTurnId: 'turn-recover',
      lastFailedSnapshotId: 'snap-recover',
      lastToolCallId: 'tool-recover',
      lastEventType: 'analysis.failed'
    })
  )
  client.state.set(
    'reply:tool:tool-recover',
    JSON.stringify({
      toolCallId: 'tool-recover',
      sessionId: 'session-recover',
      correlationId: 'corr-recover',
      turnId: 'turn-recover',
      snapshotId: 'snap-recover',
      status: 'failed'
    })
  )

  await processOrchestratorMessage(client, {
    id: '1710000000011-0',
    message: {
      payload: JSON.stringify({
        messageId: 'evt-late-success',
        type: 'analysis.completed',
        sessionId: 'session-recover',
        correlationId: 'corr-recover',
        causationId: 'cause-recover',
        turnId: 'turn-recover',
        snapshotId: 'snap-recover',
        schemaVersion: '2.0',
        toolCallId: 'tool-recover',
        payload: { species: 'Monstera' }
      })
    }
  })

  const visualState = JSON.parse(client.state.get('state:session-visual:session-recover'))
  assert.equal(visualState.analysisState, 'completed')
  assert.equal(visualState.snapshotState, 'completed')
  assert.equal(visualState.lastCompletedCorrelationId, 'corr-recover')
  assert.equal(visualState.lastEventType, 'analysis.completed')

  const turnState = JSON.parse(client.state.get('state:turn:turn-recover'))
  const snapshotState = JSON.parse(client.state.get('state:snapshot:snap-recover'))
  assert.equal(turnState.status, 'completed')
  assert.equal(snapshotState.status, 'completed')

  const replyContext = client.calls.find((call) => call[0] === 'set' && call[1] === 'reply:tool:tool-recover')
  assert.ok(replyContext, 'tool reply context should be reset to completed')
  assert.equal(JSON.parse(replyContext[2]).status, 'completed')

  const sessionAdds = client.calls.filter((call) => call[0] === 'xAdd' && call[1] === 'stream:session-events')
  assert.equal(sessionAdds.length, 0, 'late success should not emit duplicate completion events')
})
