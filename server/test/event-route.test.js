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
    payload: { source: 'camera' },
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
