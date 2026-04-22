const test = require('node:test')
const assert = require('node:assert/strict')
const { parseModelJson } = require('../lib/model-json')

test('parseModelJson parses raw JSON', () => {
  const result = parseModelJson('{"a":1}')
  assert.deepEqual(result, { a: 1 })
})

test('parseModelJson parses fenced JSON', () => {
  const result = parseModelJson('```json\n{"a":1}\n```')
  assert.deepEqual(result, { a: 1 })
})

test('parseModelJson returns null for invalid json', () => {
  const result = parseModelJson('not-json')
  assert.equal(result, null)
})
