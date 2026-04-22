function buildMinStreamId(nowMs, retentionHours) {
  const retentionMs = Math.max(0, Number(retentionHours) || 0) * 60 * 60 * 1000
  const thresholdMs = Math.max(0, nowMs - retentionMs)
  return `${Math.floor(thresholdMs)}-0`
}

module.exports = { buildMinStreamId }
