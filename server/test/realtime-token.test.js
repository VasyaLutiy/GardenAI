const test = require('node:test')
const assert = require('node:assert/strict')

process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com'
process.env.AZURE_OPENAI_API_KEY = 'test-key'
process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT = 'realtime-test'
process.env.REALTIME_TOKEN_AUTH_SECRET = 'shared-secret'

const { app, REALTIME_TOKEN_AUTH_HEADER } = require('../index')

async function withServer(run) {
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

test('GET /api/realtime-token returns 401 when auth header is missing', async () => {
  const requestFetch = global.fetch
  const originalFetch = global.fetch
  let azureCalled = false
  global.fetch = async () => {
    azureCalled = true
    throw new Error('Azure fetch should not run without auth')
  }

  try {
    await withServer(async (baseUrl) => {
      const response = await requestFetch(`${baseUrl}/api/realtime-token`)
      const body = await response.json()

      assert.equal(response.status, 401)
      assert.equal(body.code, 'unauthorized')
      assert.equal(body.error, 'Missing or invalid realtime token auth secret')
      assert.equal(azureCalled, false)
    })
  } finally {
    global.fetch = originalFetch
  }
})

test('GET /api/realtime-token returns token payload when auth header is valid', async () => {
  const requestFetch = global.fetch
  const originalFetch = global.fetch
  const fetchCalls = []
  global.fetch = async (url, options) => {
    fetchCalls.push([url, options])
    return {
      ok: true,
      async json() {
        return {
          value: 'ephemeral-token',
          expires_at: '2026-04-22T10:00:00Z'
        }
      }
    }
  }

  try {
    await withServer(async (baseUrl) => {
      const response = await requestFetch(`${baseUrl}/api/realtime-token`, {
        headers: { [REALTIME_TOKEN_AUTH_HEADER]: process.env.REALTIME_TOKEN_AUTH_SECRET }
      })
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.token, 'ephemeral-token')
      assert.equal(body.model, 'realtime-test')
      assert.equal(body.realtimeUrl, 'https://example.openai.azure.com/openai/v1/realtime/calls')
      assert.equal(body.expiresAt, '2026-04-22T10:00:00Z')
    })
  } finally {
    global.fetch = originalFetch
  }

  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0][0], 'https://example.openai.azure.com/openai/v1/realtime/client_secrets')
  assert.equal(fetchCalls[0][1].method, 'POST')
  assert.equal(fetchCalls[0][1].headers['api-key'], 'test-key')
})
