// Перенесено 1-в-1 из client/src/App.jsx (строки 119–174)
// Чистый JS — никаких браузерных зависимостей

export interface InferredIntent {
  intent: 'identify_plant' | 'diagnose_plant' | 'care_advice'
  confidence: number
}

export function inferIntentFromText(text: string): InferredIntent | null {
  const normalized = String(text || '').toLowerCase()
  if (!normalized) return null

  if (
    normalized.includes('what is this plant') ||
    normalized.includes('identify') ||
    normalized.includes('какое это растение') ||
    normalized.includes('что это за растение')
  ) {
    return { intent: 'identify_plant', confidence: 0.8 }
  }
  if (
    normalized.includes('what is wrong') ||
    normalized.includes('disease') ||
    normalized.includes('help with this plant') ||
    normalized.includes('что с растением') ||
    normalized.includes('что с листьями') ||
    normalized.includes('болеет')
  ) {
    return { intent: 'diagnose_plant', confidence: 0.82 }
  }
  if (
    normalized.includes('how to care') ||
    normalized.includes('care advice') ||
    normalized.includes('как ухаживать')
  ) {
    return { intent: 'care_advice', confidence: 0.75 }
  }
  return null
}

