const test = require('node:test')
const assert = require('node:assert/strict')

const { app } = require('../index')

async function withServer(run) {
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    app.locals.eventIngestDeps = undefined
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

function createEnvelope(overrides = {}) {
  return {
    messageId: 'evt-1',
    type: 'capture.requested',
    sessionId: 'session-1',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    tsWallIso: '2026-04-22T12:00:00.000Z',
    schemaVersion: '2.0',
    turnId: 'turn-1',
    snapshotId: 'snap-1',
    payload: { reason: 'need a snapshot', captureMode: 'fresh_photo' },
    ...overrides
  }
}

test('POST /api/events returns accepted when atomic enqueue succeeds', async () => {
  const calls = []
  app.locals.eventIngestDeps = {
    redisReady: true,
    redisClient: {
      async sendCommand(args) {
        calls.push(args)
        return 1
      }
    }
  }

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createEnvelope())
    })
    const body = await response.json()

    assert.equal(response.status, 202)
    assert.equal(body.status, 'accepted')
    assert.equal(body.messageId, 'evt-1')
    assert.equal(body.stream, 'stream:session-events')
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'EVAL')
})

test('POST /api/events returns duplicate when atomic enqueue reports an existing messageId', async () => {
  app.locals.eventIngestDeps = {
    redisReady: true,
    redisClient: {
      async sendCommand() {
        return 0
      }
    }
  }

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createEnvelope({ messageId: 'evt-duplicate' }))
    })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.status, 'duplicate')
    assert.equal(body.messageId, 'evt-duplicate')
  })
})

test('POST /api/events rejects snapshot.uploaded without orchestration state (fail-closed)', async () => {
  const gets = []
  app.locals.eventIngestDeps = {
    redisReady: true,
    redisClient: {
      async get(key) {
        gets.push(key)
        return null
      },
      async sendCommand() {
        throw new Error('enqueue should not run when state is missing')
      }
    }
  }

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        createEnvelope({
          type: 'snapshot.uploaded',
          snapshotId: 'snap-missing',
          payload: { artifactKey: 'artifact:image:snap-missing', replyKey: 'analysis:reply:snap-missing' }
        })
      )
    })
    const body = await response.json()

    assert.equal(response.status, 409)
    assert.equal(body.code, 'orchestration_state_missing')
  })

  assert.ok(gets.some((key) => key.includes('state:session-visual:session-1')))
})

test('POST /api/events rejects analysis.requested without orchestration state (fail-closed)', async () => {
  app.locals.eventIngestDeps = {
    redisReady: true,
    redisClient: {
      async get() {
        return null
      },
      async sendCommand() {
        throw new Error('enqueue should not run when state is missing')
      }
    }
  }

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        createEnvelope({
          type: 'analysis.requested',
          snapshotId: 'snap-analysis',
          payload: {
            analysisGoal: 'diagnose',
            artifactKey: 'artifact:image:snap-analysis',
            replyKey: 'analysis:reply:snap-analysis'
          }
        })
      )
    })
    const body = await response.json()

    assert.equal(response.status, 409)
    assert.equal(body.code, 'orchestration_state_missing')
  })
})

test('POST /api/events rejects analysis.requested with invalid visual transition', async () => {
  app.locals.eventIngestDeps = {
    redisReady: true,
    redisClient: {
      async get() {
        return JSON.stringify({
          sessionId: 'session-1',
          activeTurnId: 'turn-1',
          activeSnapshotId: 'snap-analysis',
          captureState: 'captured',
          snapshotState: 'available',
          analysisState: 'idle'
        })
      },
      async sendCommand() {
        throw new Error('enqueue should not run on invalid transition')
      }
    }
  }

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        createEnvelope({
          type: 'analysis.requested',
          snapshotId: 'snap-analysis',
          payload: {
            analysisGoal: 'diagnose',
            imageArtifactKey: 'artifact:image:snap-analysis',
            replyKey: 'analysis:reply:snap-analysis'
          }
        })
      )
    })
    const body = await response.json()

    assert.equal(response.status, 409)
    assert.equal(body.code, 'invalid_visual_transition')
  })
})

test('POST /api/events rejects visual analysis completion without orchestration state', async () => {
  app.locals.eventIngestDeps = {
    redisReady: true,
    redisClient: {
      async get() {
        return null
      },
      async sendCommand() {
        throw new Error('enqueue should not run')
      }
    }
  }

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId: 'evt-visual-1',
        type: 'analysis.completed',
        sessionId: 'session-1',
        correlationId: 'corr-1',
        causationId: 'cause-1',
        tsWallIso: '2026-04-22T12:00:00.000Z',
        schemaVersion: '2.0',
        turnId: 'turn-1',
        snapshotId: 'snap-1',
        payload: {
          status: 'completed'
        }
      })
    })
    const body = await response.json()

    assert.equal(response.status, 409)
    assert.equal(body.code, 'orchestration_state_missing')
  })
})
