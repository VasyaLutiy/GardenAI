function parseModelJson(content) {
  if (!content) return null
  const cleaned = String(content)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

module.exports = { parseModelJson }
