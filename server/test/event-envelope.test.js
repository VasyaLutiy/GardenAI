const test = require('node:test')
const assert = require('node:assert/strict')
const { validateEnvelope } = require('../lib/event-envelope')

test('validateEnvelope accepts canonical envelope', () => {
  const err = validateEnvelope({
    messageId: 'm1',
    type: 'analysis.requested',
    sessionId: 's1',
    payload: {}
  })
  assert.equal(err, null)
})

test('validateEnvelope requires messageId', () => {
  const err = validateEnvelope({
    type: 'analysis.requested',
    sessionId: 's1',
    payload: {}
  })
  assert.equal(err, 'messageId is required')
})
