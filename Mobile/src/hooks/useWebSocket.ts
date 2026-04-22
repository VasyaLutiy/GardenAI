import { useRef, useState, useCallback } from 'react'
import { WS_BASE } from '../config'

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

    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${encodeURIComponent(sessionId)}`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as WsMessage
        onMessage(data)
      } catch {
        // игнорируем невалидный JSON
      }
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
    }

    ws.onerror = () => setConnected(false)
  }, [sessionId, onMessage])

  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
    setConnected(false)
  }, [])

  return { connected, connect, disconnect }
}
