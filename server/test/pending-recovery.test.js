const test = require('node:test')
const assert = require('node:assert/strict')

const { drainPendingStreamMessages } = require('../index')

test('drainPendingStreamMessages claims and processes pending entries before returning', async () => {
  const calls = []
  const client = {
    async xAutoClaim(stream, group, consumer, minIdleMs, startId, options) {
      calls.push(['xAutoClaim', stream, group, consumer, minIdleMs, startId, options])
      if (startId === '0-0') {
        return {
          nextId: '2-0',
          messages: [
            { id: '1-0', message: { payload: '{"type":"first"}' } },
            { id: '2-0', message: { payload: '{"type":"second"}' } }
          ]
        }
      }
      return { nextId: '0-0', messages: [] }
    }
  }

  const seen = []
  await drainPendingStreamMessages(
    client,
    'stream:test',
    'group:test',
    'consumer-a',
    10,
    60000,
    async (msg) => {
      seen.push(msg.id)
    }
  )

  assert.deepEqual(seen, ['1-0', '2-0'])
  assert.deepEqual(calls[0], [
    'xAutoClaim',
    'stream:test',
    'group:test',
    'consumer-a',
    60000,
    '0-0',
    { COUNT: 10 }
  ])
})

test('drainPendingStreamMessages follows an advanced nextId after an empty page', async () => {
  const calls = []
  const client = {
    async xAutoClaim(stream, group, consumer, minIdleMs, startId, options) {
      calls.push(startId)
      if (startId === '0-0') {
        return { nextId: '2-0', messages: [] }
      }
      if (startId === '2-0') {
        return {
          nextId: '0-0',
          messages: [{ id: '3-0', message: { payload: '{"type":"later"}' } }]
        }
      }
      return { nextId: '0-0', messages: [] }
    }
  }

  const seen = []
  await drainPendingStreamMessages(client, 'stream:test', 'group:test', 'consumer-a', 10, 60000, async (msg) => {
    seen.push(msg.id)
  })

  assert.deepEqual(calls, ['0-0', '2-0'])
  assert.deepEqual(seen, ['3-0'])
})

test('drainPendingStreamMessages skips null messages entries', async () => {
  const client = {
    async xAutoClaim() {
      return {
        nextId: '0-0',
        messages: [null, { id: '4-0', message: { payload: '{"type":"valid"}' } }, undefined]
      }
    }
  }

  const seen = []
  await drainPendingStreamMessages(client, 'stream:test', 'group:test', 'consumer-a', 10, 60000, async (msg) => {
    seen.push(msg.id)
  })

  assert.deepEqual(seen, ['4-0'])
})
