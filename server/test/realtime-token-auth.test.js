const test = require('node:test')
const assert = require('node:assert/strict')

process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com'
process.env.AZURE_OPENAI_API_KEY = 'test-key'
process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT = 'realtime-test'
process.env.REALTIME_TOKEN_AUTH_SECRET = 'shared-secret'

const { handleRealtimeTokenRequest } = require('../index')

function createRes() {
  const res = {
    statusCode: 200,
    body: null
  }
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (body) => {
    res.body = body
    return res
  }
  return res
}

function createReq(headers = {}) {
  return {
    requestId: 'req-1',
    get(name) {
      return headers[String(name).toLowerCase()] || headers[name] || undefined
    }
  }
}

test('handleRealtimeTokenRequest rejects missing auth secret with 401', async () => {
  const req = createReq()
  const res = createRes()

  await handleRealtimeTokenRequest(req, res, {
    fetchImpl: async () => {
      throw new Error('should not call Azure')
    }
  })

  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'unauthorized')
})

test('handleRealtimeTokenRequest accepts the shared secret and mints a token', async () => {
  const req = createReq({
    'x-gardenai-realtime-token-secret': 'shared-secret'
  })
  const res = createRes()

  await handleRealtimeTokenRequest(req, res, {
    fetchImpl: async (url, options) => {
      assert.match(url, /\/openai\/v1\/realtime\/client_secrets$/)
      assert.equal(options.method, 'POST')
      assert.equal(options.headers['api-key'], 'test-key')
      return {
        ok: true,
        async json() {
          return { value: 'minted-token', expires_at: '2026-01-01T00:00:00Z' }
        }
      }
    }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.token, 'minted-token')
  assert.equal(res.body.model, 'realtime-test')
})
