const test = require('node:test')
const assert = require('node:assert/strict')
const { buildMinStreamId } = require('../lib/stream-retention')

test('buildMinStreamId computes retention threshold id', () => {
  const now = 2000
  const id = buildMinStreamId(now, 1 / 3600000)
  assert.equal(id, '1999-0')
})

test('buildMinStreamId clamps to zero', () => {
  const id = buildMinStreamId(500, 1)
  assert.equal(id, '0-0')
})
