/**
 * Простой файловый логгер для отладки на устройстве.
 * Пишет в <app-documents>/debug.log
 * Читать (debuggable build):
 * adb shell run-as com.gardenai.mobile cat files/debug.log > /tmp/gardenai-debug.log
 */
import * as FileSystem from 'expo-file-system'

const LOG_PATH = (FileSystem.documentDirectory ?? '') + 'debug.log'
const MAX_LINES = 4000
const MAX_CHARS_PER_LINE = 4000

let buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let sequence = 0

function ts() {
  return new Date().toISOString().slice(11, 23) // HH:mm:ss.mmm
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatArg(value: unknown): string {
  const text = safeStringify(value)
  return text.length > MAX_CHARS_PER_LINE ? `${text.slice(0, MAX_CHARS_PER_LINE)}…` : text
}

function scheduleFlush(delayMs = 500) {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const content = buffer.join('\n') + '\n'
    FileSystem.writeAsStringAsync(LOG_PATH, content, {
      encoding: FileSystem.EncodingType.UTF8,
    }).catch(() => {})
  }, delayMs)
}

export function dlog(tag: string, ...args: unknown[]) {
  sequence += 1
  const line = `[${ts()}][${String(sequence).padStart(5, '0')}][${tag}] ${args.map(formatArg).join(' ')}`
  buffer.push(line)
  if (buffer.length > MAX_LINES) buffer = buffer.slice(-MAX_LINES)
  scheduleFlush()
}

export function logOrchestration(event: string, payload: Record<string, unknown> = {}) {
  dlog('ORCH', event, payload)
}

export function startDebugSession(context: Record<string, unknown> = {}) {
  dlog('APP', '===== debug session start =====', context)
}

export async function flushDebugLog() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const content = buffer.join('\n') + '\n'
  await FileSystem.writeAsStringAsync(LOG_PATH, content, {
    encoding: FileSystem.EncodingType.UTF8,
  })
}

/** Очистить лог (при старте новой сессии) */
export function clearLog() {
  buffer = []
  sequence = 0
  FileSystem.writeAsStringAsync(LOG_PATH, '', {
    encoding: FileSystem.EncodingType.UTF8,
  }).catch(() => {})
}

export async function resetDebugLog() {
  buffer = []
  sequence = 0
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await FileSystem.writeAsStringAsync(LOG_PATH, '', {
    encoding: FileSystem.EncodingType.UTF8,
  })
}

export async function getDebugLogInfo() {
  const info = await FileSystem.getInfoAsync(LOG_PATH)
  return {
    path: LOG_PATH,
    exists: info.exists,
    size: info.exists ? info.size ?? 0 : 0,
    linesBuffered: buffer.length,
  }
}

export { LOG_PATH }
