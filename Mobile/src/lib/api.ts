import axios from 'axios'
import { API_BASE, REALTIME_TOKEN_AUTH_HEADER, REALTIME_TOKEN_AUTH_SECRET } from '../config'
import type { EventEnvelope } from './eventBus'
import { dlog, logOrchestration } from './debugLog'

const http = axios.create({ baseURL: API_BASE, timeout: 30000 })

export async function postEvent(event: EventEnvelope): Promise<void> {
  const startedAt = Date.now()
  logOrchestration('http.postEvent.request', {
    type: event.type,
    messageId: event.messageId,
    sessionId: event.sessionId,
    correlationId: event.correlationId,
    turnId: event.turnId ?? null,
    snapshotId: event.snapshotId ?? null,
  })
  await http.post('/api/events', event)
  logOrchestration('http.postEvent.response', {
    type: event.type,
    messageId: event.messageId,
    durationMs: Date.now() - startedAt,
  })
}

export interface RealtimeTokenResponse {
  token: string
  realtimeUrl: string
  model: string
  expiresAt?: string
}

export async function fetchRealtimeToken(): Promise<RealtimeTokenResponse> {
  const startedAt = Date.now()
  dlog('HTTP', 'GET /api/realtime-token', {
    baseURL: API_BASE,
    hasAuthSecret: Boolean(REALTIME_TOKEN_AUTH_SECRET),
  })
  const { data } = await http.get<RealtimeTokenResponse>('/api/realtime-token', {
    headers: REALTIME_TOKEN_AUTH_SECRET
      ? { [REALTIME_TOKEN_AUTH_HEADER]: REALTIME_TOKEN_AUTH_SECRET }
      : undefined,
  })
  dlog('HTTP', 'GET /api/realtime-token OK', {
    durationMs: Date.now() - startedAt,
    model: data.model,
    expiresAt: data.expiresAt ?? null,
  })
  return data
}

export interface AnalysisResult {
  species: string
  confidence: number
  diagnoses: string[]
  suggestions: string[]
  urgency: 'low' | 'medium' | 'high'
  disclaimer: string
}

export interface UploadAnalysisOptions {
  snapshotId?: string
  turnId?: string
  toolCallId?: string
  analysisGoal?: 'identify' | 'diagnose' | 'care_advice'
  captureTs?: string
  framingHint?: string
  source?: string
}

// FormData с URI — надёжный способ для Android и iOS.
// Не используем Blob/toDataURL (нет Canvas в RN).
export async function uploadImageForAnalysis(
  uri: string,
  sessionId: string,
  correlationId: string,
  causationId: string,
  options: UploadAnalysisOptions = {},
): Promise<AnalysisResult> {
  const startedAt = Date.now()
  const fd = new FormData()
  fd.append('image', { uri, type: 'image/jpeg', name: 'capture.jpg' } as unknown as Blob)
  fd.append('sessionId', sessionId)
  fd.append('correlationId', correlationId)
  fd.append('causationId', causationId)
  if (options.snapshotId) fd.append('snapshotId', options.snapshotId)
  if (options.turnId) fd.append('turnId', options.turnId)
  if (options.toolCallId) fd.append('toolCallId', options.toolCallId)
  if (options.analysisGoal) fd.append('analysisGoal', options.analysisGoal)
  if (options.captureTs) fd.append('captureTs', options.captureTs)
  if (options.framingHint) fd.append('framingHint', options.framingHint)
  if (options.source) fd.append('source', options.source)

  logOrchestration('http.uploadImageForAnalysis.request', {
    sessionId,
    correlationId,
    causationId,
    snapshotId: options.snapshotId ?? null,
    turnId: options.turnId ?? null,
    toolCallId: options.toolCallId ?? null,
    analysisGoal: options.analysisGoal ?? null,
    framingHint: options.framingHint ?? null,
    source: options.source ?? null,
    uri,
  })

  const { data } = await http.post<AnalysisResult>('/api/analyze-image', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  logOrchestration('http.uploadImageForAnalysis.response', {
    sessionId,
    correlationId,
    snapshotId: options.snapshotId ?? null,
    turnId: options.turnId ?? null,
    toolCallId: options.toolCallId ?? null,
    analysisGoal: options.analysisGoal ?? null,
    durationMs: Date.now() - startedAt,
    species: data.species,
    confidence: data.confidence,
    urgency: data.urgency,
  })
  return data
}
