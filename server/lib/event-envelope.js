const VISUAL_EVENT_TYPES = new Set([
  'capture.requested',
  'capture.accepted',
  'capture.rejected',
  'snapshot.available',
  'snapshot.upload.requested',
  'snapshot.uploaded',
  'analysis.requested',
  'analysis.completed',
  'analysis.failed',
  'reframe.requested',
  'assistant.visual_guidance'
])

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireString(body, key) {
  return !body[key] || typeof body[key] !== 'string' ? `${key} is required` : null
}

function requirePayloadString(payload, key) {
  return !payload[key] || typeof payload[key] !== 'string' ? `payload.${key} is required` : null
}

function validateEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object'
  const messageIdError = requireString(body, 'messageId')
  if (messageIdError) return messageIdError
  const typeError = requireString(body, 'type')
  if (typeError) return typeError
  const sessionIdError = requireString(body, 'sessionId')
  if (sessionIdError) return sessionIdError
  const tsWallIsoError = requireString(body, 'tsWallIso')
  if (tsWallIsoError) return tsWallIsoError
  const schemaVersionError = requireString(body, 'schemaVersion')
  if (schemaVersionError) return schemaVersionError
  if (!Object.prototype.hasOwnProperty.call(body, 'payload')) return 'payload is required'
  if (!isObject(body.payload)) return 'payload must be a JSON object'

  if (VISUAL_EVENT_TYPES.has(body.type)) {
    const requiredTopLevel = ['correlationId', 'causationId']
    for (const key of requiredTopLevel) {
      const error = requireString(body, key)
      if (error) return error
    }

    if (!Object.prototype.hasOwnProperty.call(body, 'turnId') || typeof body.turnId !== 'string') {
      return 'turnId is required for visual events'
    }

    const payload = body.payload
    if (body.type === 'capture.requested') {
      const error = requirePayloadString(payload, 'reason')
      if (error) return error
    }

    if (
      body.type === 'snapshot.available' ||
      body.type === 'snapshot.upload.requested' ||
      body.type === 'snapshot.uploaded' ||
      body.type === 'analysis.requested' ||
      body.type === 'analysis.completed' ||
      body.type === 'analysis.failed' ||
      body.type === 'reframe.requested'
    ) {
      if (!Object.prototype.hasOwnProperty.call(body, 'snapshotId') || typeof body.snapshotId !== 'string') {
        return 'snapshotId is required for visual events'
      }
    }

    if (body.type === 'analysis.requested') {
      const error = requirePayloadString(payload, 'analysisGoal')
      if (error) return error
    }
    if (body.type === 'snapshot.upload.requested') {
      const error = requirePayloadString(payload, 'uploadStrategy')
      if (error) return error
    }
    if (body.type === 'reframe.requested') {
      const error = requirePayloadString(payload, 'reason') || requirePayloadString(payload, 'framingHint')
      if (error) return error
    }
    if (body.type === 'snapshot.uploaded') {
      const error = requirePayloadString(payload, 'artifactKey')
      if (error) return error
    }
  }

  return null
}

module.exports = { validateEnvelope }
