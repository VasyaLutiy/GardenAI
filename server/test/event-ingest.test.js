const test = require('node:test')
const assert = require('node:assert/strict')

process.env.RETENTION_HOURS = '24'

const { enqueueSessionEventAtomically } = require('../index')

function createClient(result = 1) {
  const calls = []
  return {
    calls,
    async sendCommand(args) {
      calls.push(args)
      return result
    }
  }
}

test('enqueueSessionEventAtomically publishes stream and fanout in one Redis script', async () => {
  const client = createClient(1)
  const event = {
    messageId: 'msg-1',
    type: 'capture.requested',
    sessionId: 'session-1',
    payload: { source: 'camera' }
  }

  const status = await enqueueSessionEventAtomically(client, event)

  assert.equal(status, 'accepted')
  assert.equal(client.calls.length, 1)
  const [command, script, keyCount, dedupeKey, stream, channel, ttl, payload] = client.calls[0]
  assert.equal(command, 'EVAL')
  assert.match(script, /local decoded = cjson\.decode\(payload\)/)
  assert.match(script, /redis\.call\('TYPE', streamKey\)/)
  assert.equal(keyCount, '2')
  assert.equal(dedupeKey, 'dedupe:msg-1')
  assert.equal(stream, 'stream:session-events')
  assert.equal(channel, 'chan:session:session-1')
  assert.equal(ttl, '86400')
  assert.equal(JSON.parse(payload).messageId, 'msg-1')
  assert.ok(script.indexOf("redis.call('XADD'") < script.indexOf("redis.call('SET', dedupeKey, '1', 'EX', ttlSeconds)"))
})

test('enqueueSessionEventAtomically reports duplicates without retrying side effects', async () => {
  const client = createClient(0)
  const status = await enqueueSessionEventAtomically(client, {
    messageId: 'msg-dup',
    type: 'capture.requested',
    sessionId: 'session-dup',
    payload: {}
  })

  assert.equal(status, 'duplicate')
  assert.equal(client.calls.length, 1)
})
