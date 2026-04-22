const test = require('node:test')
const assert = require('node:assert/strict')
const { validateEnvelope } = require('../lib/event-envelope')

test('validateEnvelope accepts canonical envelope', () => {
  const err = validateEnvelope({
    messageId: 'm1',
    type: 'intent.detected',
    sessionId: 's1',
    tsWallIso: '2026-04-22T12:00:00.000Z',
    schemaVersion: '2.0',
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

test('validateEnvelope requires tsWallIso', () => {
  const err = validateEnvelope({
    messageId: 'm-ts',
    type: 'intent.detected',
    sessionId: 's1',
    schemaVersion: '2.0',
    payload: {}
  })
  assert.equal(err, 'tsWallIso is required')
})

test('validateEnvelope requires visual envelope fields for analysis.completed', () => {
  const err = validateEnvelope({
    messageId: 'm2',
    type: 'analysis.completed',
    sessionId: 's1',
    correlationId: 'c1',
    causationId: 'cause-1',
    tsWallIso: '2026-04-22T12:00:00.000Z',
    schemaVersion: '2.0',
    turnId: 'turn-1',
    payload: {}
  })
  assert.equal(err, 'snapshotId is required for visual events')
})

test('validateEnvelope accepts strict visual analysis envelope', () => {
  const err = validateEnvelope({
    messageId: 'm3',
    type: 'analysis.requested',
    sessionId: 's1',
    correlationId: 'c1',
    causationId: 'call-1',
    tsWallIso: '2026-04-22T12:00:00.000Z',
    schemaVersion: '2.0',
    turnId: 'turn-1',
    snapshotId: 'snap-1',
    payload: { analysisGoal: 'diagnose' }
  })
  assert.equal(err, null)
})

test('validateEnvelope requires uploadStrategy for snapshot.upload.requested', () => {
  const err = validateEnvelope({
    messageId: 'm4',
    type: 'snapshot.upload.requested',
    sessionId: 's1',
    correlationId: 'c1',
    causationId: 'cause-1',
    tsWallIso: '2026-04-22T12:00:00.000Z',
    schemaVersion: '2.0',
    turnId: 'turn-1',
    snapshotId: 'snap-1',
    payload: {}
  })
  assert.equal(err, 'payload.uploadStrategy is required')
})
