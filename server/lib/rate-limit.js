function createRateLimiter({ windowMs, max }) {
  const store = new Map()
  const window = Math.max(1, Number(windowMs) || 60000)
  const limit = Math.max(1, Number(max) || 60)

  function check(key) {
    const now = Date.now()
    const entry = store.get(key) || { count: 0, resetAt: now + window }
    if (now > entry.resetAt) {
      entry.count = 0
      entry.resetAt = now + window
    }
    entry.count += 1
    store.set(key, entry)
    const remaining = Math.max(0, limit - entry.count)
    return {
      allowed: entry.count <= limit,
      remaining,
      resetAt: entry.resetAt,
      limit
    }
  }

  return { check }
}

module.exports = { createRateLimiter }
