import * as Crypto from 'expo-crypto'

// Заменяет crypto.randomUUID из браузерного App.jsx —
// expo-crypto работает одинаково на Android и iOS
export function createId(prefix: string): string {
  return `${prefix}-${Crypto.randomUUID()}`
}

export interface EventEnvelope {
  messageId: string
  type: string
  sessionId: string
  correlationId: string
  causationId: string
  tsWallIso: string
  schemaVersion: string
  payload: Record<string, unknown>
  snapshotId?: string
  turnId?: string
}

export function buildEnvelope(
  type: string,
  sessionId: string,
  payload: Record<string, unknown>,
  correlationId?: string,
  causationId?: string,
  snapshotId?: string,
  turnId?: string,
): EventEnvelope {
  return {
    messageId: createId('evt'),
    type,
    sessionId,
    correlationId: correlationId ?? createId('corr'),
    causationId: causationId ?? createId('cause'),
    tsWallIso: new Date().toISOString(),
    schemaVersion: '1.0',
    payload,
    snapshotId,
    turnId,
  }
}
