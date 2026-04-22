const test = require('node:test')
const assert = require('node:assert/strict')
const { createRateLimiter } = require('../lib/rate-limit')

test('rate limiter blocks after max', async () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 2 })
  const key = 'ip:1'
  assert.equal(limiter.check(key).allowed, true)
  assert.equal(limiter.check(key).allowed, true)
  assert.equal(limiter.check(key).allowed, false)
})
