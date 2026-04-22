const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

function normalizeLevel(level) {
  const raw = String(level || 'info').toLowerCase()
  return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? raw : 'info'
}

function createLogger(options = {}) {
  const service = options.service || 'app'
  const minLevel = normalizeLevel(options.level)
  const json = options.json !== false
  const base = options.base && typeof options.base === 'object' ? { ...options.base } : {}

  function shouldLog(level) {
    return LEVELS[normalizeLevel(level)] >= LEVELS[minLevel]
  }

  function write(level, message, fields) {
    const normalizedLevel = normalizeLevel(level)
    if (!shouldLog(normalizedLevel)) return

    const payload = {
      ts: new Date().toISOString(),
      level: normalizedLevel,
      service,
      ...base
    }

    if (message) payload.message = message
    if (fields && typeof fields === 'object') {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) payload[key] = value
      }
    }

    const line = json
      ? JSON.stringify(payload)
      : `[${payload.ts}] ${payload.level.toUpperCase()} ${service} ${payload.component || 'app'} ${payload.message || ''} ${JSON.stringify(fields || {})}`
    if (normalizedLevel === 'error') {
      console.error(line)
      return
    }
    if (normalizedLevel === 'warn') {
      console.warn(line)
      return
    }
    console.log(line)
  }

  function child(extraBase = {}) {
    return createLogger({
      service,
      level: minLevel,
      json,
      base: {
        ...base,
        ...(extraBase || {})
      }
    })
  }

  return {
    debug(message, fields) {
      write('debug', message, fields)
    },
    info(message, fields) {
      write('info', message, fields)
    },
    warn(message, fields) {
      write('warn', message, fields)
    },
    error(message, fields) {
      write('error', message, fields)
    },
    child
  }
}

module.exports = { createLogger }
