function validateEnvelope(body) {
  if (!body || typeof body !== 'object') return 'Request body must be a JSON object'
  if (!body.messageId || typeof body.messageId !== 'string') return 'messageId is required'
  if (!body.type || typeof body.type !== 'string') return 'type is required'
  if (!body.sessionId || typeof body.sessionId !== 'string') return 'sessionId is required'
  if (!Object.prototype.hasOwnProperty.call(body, 'payload')) return 'payload is required'
  return null
}

module.exports = { validateEnvelope }
