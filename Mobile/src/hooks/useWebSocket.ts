import { useRef, useState, useCallback } from 'react'
import { WS_BASE } from '../config'
import { dlog, logOrchestration } from '../lib/debugLog'

export type WsMessage = Record<string, unknown>

interface UseWebSocketOptions {
  sessionId: string
  onMessage: (msg: WsMessage) => void
}

// React Native имеет встроенный WebSocket с идентичным браузерному API —
// этот хук является почти прямым портом connectWs/disconnectWs из App.jsx
export function useWebSocket({ sessionId, onMessage }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const url = `${WS_BASE}/ws?sessionId=${encodeURIComponent(sessionId)}`
    dlog('WS', 'connect', { sessionId, url })
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      dlog('WS', 'open', { sessionId })
      setConnected(true)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as WsMessage
        logOrchestration('ws.message', {
          sessionId,
          type: typeof data.type === 'string' ? data.type : 'unknown',
          messageId: typeof data.messageId === 'string' ? data.messageId : null,
          correlationId: typeof data.correlationId === 'string' ? data.correlationId : null,
          turnId: typeof data.turnId === 'string' ? data.turnId : null,
          snapshotId: typeof data.snapshotId === 'string' ? data.snapshotId : null,
        })
        onMessage(data)
      } catch {
        dlog('WS', 'invalid-json', { sessionId, raw: String(event.data).slice(0, 300) })
      }
    }

    ws.onclose = () => {
      dlog('WS', 'close', { sessionId })
      setConnected(false)
      wsRef.current = null
    }

    ws.onerror = () => {
      dlog('WS', 'error', { sessionId })
      setConnected(false)
    }
  }, [sessionId, onMessage])

  const disconnect = useCallback(() => {
    dlog('WS', 'disconnect', { sessionId })
    wsRef.current?.close()
    wsRef.current = null
    setConnected(false)
  }, [sessionId])

  return { connected, connect, disconnect }
}
