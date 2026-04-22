/**
 * Простой файловый логгер для отладки на устройстве.
 * Пишет в <app-documents>/debug.log
 * Читать: adb pull /data/data/com.gardenai.mobile/files/debug.log /tmp/debug.log
 */
import * as FileSystem from 'expo-file-system'

const LOG_PATH = (FileSystem.documentDirectory ?? '') + 'debug.log'
const MAX_LINES = 1000

let buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function ts() {
  return new Date().toISOString().slice(11, 23) // HH:mm:ss.mmm
}

export function dlog(tag: string, ...args: unknown[]) {
  const line = `[${ts()}][${tag}] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`
  buffer.push(line)
  if (buffer.length > MAX_LINES) buffer = buffer.slice(-MAX_LINES)

  // Дебаунс записи на диск — раз в 500ms
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      const content = buffer.join('\n') + '\n'
      FileSystem.writeAsStringAsync(LOG_PATH, content, {
        encoding: FileSystem.EncodingType.UTF8,
      }).catch(() => {})
    }, 500)
  }
}

/** Очистить лог (при старте новой сессии) */
export function clearLog() {
  buffer = []
  FileSystem.writeAsStringAsync(LOG_PATH, '', {
    encoding: FileSystem.EncodingType.UTF8,
  }).catch(() => {})
}

export { LOG_PATH }
