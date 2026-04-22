import { useRef, useState, useCallback } from 'react'
import {
  RTCPeerConnection,
  mediaDevices,
  type MediaStream,
} from 'react-native-webrtc'
import InCallManager from 'react-native-incall-manager'
import { fetchRealtimeToken } from '../lib/api'
import { dlog, logOrchestration } from '../lib/debugLog'
import {
  VISUAL_TOOLS,
  ALEX_SYSTEM_PROMPT,
} from '../config'

interface UseRealtimeOptions {
  onTranscriptDelta: (text: string) => void
  onTranscriptDone: (responseId: string, text: string) => void
  onUserTranscript: (text: string) => void
  onToolCall: (name: string, callId: string, args: Record<string, unknown>) => void
  onEvent: (event: Record<string, unknown>) => void
}

function serializeOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

export function useRealtime({
  onTranscriptDelta,
  onTranscriptDone,
  onUserTranscript,
  onToolCall,
  onEvent,
}: UseRealtimeOptions) {
  const pcRef = useRef<InstanceType<typeof RTCPeerConnection> | null>(null)
  const dcRef = useRef<ReturnType<InstanceType<typeof RTCPeerConnection>['createDataChannel']> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const transcriptBufferRef = useRef<Record<string, string>>({})
  const connectedRef = useRef(false)
  const startingRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef = useRef<() => Promise<void>>()

  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('')

  const sendEnvelope = useCallback((payload: Record<string, unknown>, createResponse = true) => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    const type = typeof payload.type === 'string' ? payload.type : 'unknown'
    if (type !== 'response.cancel') {
      dlog('DC:OUT', {
        type,
        createResponse,
        callId:
          typeof payload.item === 'object' &&
          payload.item &&
          typeof (payload.item as Record<string, unknown>).call_id === 'string'
            ? (payload.item as Record<string, unknown>).call_id
            : null,
      })
    }
    dc.send(JSON.stringify(payload))
    if (createResponse) {
      dc.send(JSON.stringify({
        type: 'response.create',
        response: {},
      }))
    }
  }, [])

  const sendText = useCallback((text: string) => {
    sendEnvelope({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    })
  }, [sendEnvelope])

  const sendFunctionResult = useCallback((callId: string, output: unknown) => {
    logOrchestration('realtime.function_result', {
      callId,
      output,
    })
    sendEnvelope({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: serializeOutput(output),
      },
    })
  }, [sendEnvelope])

  const sendSystemEventSummary = useCallback((text: string, metadata?: Record<string, unknown>) => {
    logOrchestration('realtime.system_summary', {
      text,
      metadata: metadata ?? null,
    })
    sendEnvelope({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: metadata ? `${text}\n${JSON.stringify(metadata)}` : text,
          },
        ],
      },
    })
  }, [sendEnvelope])

  const cancelResponse = useCallback(() => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify({ type: 'response.cancel' }))
  }, [])

  const start = useCallback(async () => {
    if (connectedRef.current || startingRef.current) return
    startingRef.current = true
    dlog('RT', 'start', { connected: connectedRef.current })

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
      dcRef.current = null
    }

    try {
      setStatus('starting realtime')

      const { token, realtimeUrl, model } = await fetchRealtimeToken()
      dlog('RT', 'token ready', { model, realtimeUrl })
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false }) as MediaStream
      streamRef.current = stream
      dlog('RT', 'audio stream ready', { trackCount: stream.getTracks().length })

      InCallManager.start({ media: 'audio' })
      InCallManager.setSpeakerphoneOn(true)

      const pc = new RTCPeerConnection()
      pcRef.current = pc

      ;(pc as unknown as { onconnectionstatechange: (() => void) | null }).onconnectionstatechange = () => {
        const state = (pc as unknown as { connectionState: string }).connectionState

        if (state === 'connected') {
          dlog('RT', 'pc.connected')
          connectedRef.current = true
          startingRef.current = false
          setConnected(true)
          setStatus('realtime connected')
        }

        if (state === 'disconnected') {
          dlog('RT', 'pc.disconnected')
          connectedRef.current = false
          setConnected(false)
          setStatus('realtime disconnected — waiting for recovery...')
        }

        if (state === 'failed') {
          dlog('RT', 'pc.failed')
          connectedRef.current = false
          startingRef.current = false
          setConnected(false)
          setStatus('realtime failed — reconnecting in 3s')
          pc.close()
          streamRef.current?.getTracks().forEach((track) => track.stop())
          streamRef.current = null
          pcRef.current = null
          dcRef.current = null
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = setTimeout(() => startRef.current?.(), 3000)
        }
      }

      stream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, stream)
      })

      const dc = pc.createDataChannel('garden-events')
      dcRef.current = dc

      ;(dc as unknown as { onopen: (() => void) | null }).onopen = () => {
        dlog('RT', 'dc.onopen — waiting for session.created')
      }

      ;(dc as unknown as { onmessage: ((event: { data: string }) => void) | null }).onmessage = (event: { data: string }) => {
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(event.data as string)
        } catch {
          return
        }

        const type = payload.type as string | undefined
        if (type !== 'response.audio.delta') {
          dlog('DC', JSON.stringify(payload).slice(0, 300))
        }
        if (type === 'response.function_call_arguments.done') {
          logOrchestration('realtime.tool_call', {
            callId: payload.call_id ?? null,
            name: payload.name ?? null,
            arguments: payload.arguments ?? null,
          })
        }

        if (type === 'session.created') {
          dlog('RT', 'session.created — sending session.update')
          dc.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions: ALEX_SYSTEM_PROMPT,
              tools: VISUAL_TOOLS,
              tool_choice: 'auto',
            },
          }))
        }

        if (type === 'session.updated') {
          const session = payload.session as Record<string, unknown> | undefined
          const toolCount = (session?.tools as unknown[] | undefined)?.length ?? 0
          dlog(
            'RT',
            'session.updated tools:',
            toolCount,
            'instructions len:',
            (session?.instructions as string)?.length ?? 0,
          )
        }
        if (type === 'error') {
          dlog('RT', 'ERROR from Azure:', JSON.stringify(payload))
        }

        if (type === 'response.output_audio_transcript.delta') {
          const responseId = (payload.response_id as string) || 'unknown'
          const delta = (payload.delta as string) || ''
          const next = (transcriptBufferRef.current[responseId] || '') + delta
          transcriptBufferRef.current[responseId] = next
          onTranscriptDelta(next)
        }

        if (type === 'response.output_audio_transcript.done') {
          const responseId = (payload.response_id as string) || 'unknown'
          const text = (payload.transcript as string) || transcriptBufferRef.current[responseId] || ''
          if (text) onTranscriptDone(responseId, text)
        }

        if (type === 'conversation.item.input_audio_transcription.completed') {
          const text = (payload.transcript as string) || ''
          if (text) onUserTranscript(text)
        }

        if (type === 'response.function_call_arguments.done') {
          const callId = (payload.call_id as string) || ''
          const name = (payload.name as string) || ''
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse((payload.arguments as string) || '{}')
          } catch {
            args = {}
          }
          if (callId && name) onToolCall(name, callId, args)
        }

        const noisy =
          type === 'response.output_audio_transcript.delta' ||
          type === 'response.content_part.added' ||
          type === 'response.audio.delta'
        if (!noisy) onEvent(payload)
      }

      const offer = await pc.createOffer({})
      await pc.setLocalDescription(offer)
      dlog('RT', 'local offer ready', { sdpLength: pc.localDescription?.sdp?.length ?? 0 })

      const sdpResp = await fetch(`${realtimeUrl}?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/sdp',
        },
        body: pc.localDescription?.sdp || '',
      })

      if (!sdpResp.ok) {
        throw new Error(`SDP error ${sdpResp.status}: ${await sdpResp.text()}`)
      }

      const answerSdp = await sdpResp.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      dlog('RT', 'remote answer applied', { sdpLength: answerSdp.length })
      setStatus('realtime negotiating')
    } catch (err: unknown) {
      startingRef.current = false
      connectedRef.current = false
      const message = err instanceof Error ? err.message : String(err)
      dlog('RT', 'start error', { message })
      setStatus(`realtime error: ${message}`)
      setConnected(false)
      pcRef.current?.close()
      pcRef.current = null
      InCallManager.stop()
      reconnectTimerRef.current = setTimeout(() => startRef.current?.(), 5000)
    }
  }, [onTranscriptDelta, onTranscriptDone, onUserTranscript, onToolCall, onEvent])

  startRef.current = start

  const stop = useCallback(() => {
    dlog('RT', 'stop')
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    connectedRef.current = false
    startingRef.current = false
    dcRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    InCallManager.stop()
    setConnected(false)
    setStatus('realtime stopped')
  }, [])

  return {
    connected,
    status,
    start,
    stop,
    sendText,
    sendFunctionResult,
    sendSystemEventSummary,
    cancelResponse,
  }
}
