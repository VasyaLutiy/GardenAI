import { useRef, useState, useCallback } from 'react'
import {
  RTCPeerConnection,
  mediaDevices,
  type MediaStream,
} from 'react-native-webrtc'
import InCallManager from 'react-native-incall-manager'
import { fetchRealtimeToken } from '../lib/api'
import { dlog } from '../lib/debugLog'
import {
  REALTIME_TRANSCRIBE_MODEL,
  REALTIME_VOICE,
  REALTIME_VAD,
  TAKE_PHOTO_TOOL,
  ALEX_SYSTEM_PROMPT,
} from '../config'

interface UseRealtimeOptions {
  onTranscriptDelta: (text: string) => void
  onTranscriptDone: (responseId: string, text: string) => void
  onUserTranscript: (text: string) => void
  onToolCall: (name: string, callId: string, args: Record<string, unknown>) => void
  onEvent: (event: Record<string, unknown>) => void
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

  // Используем ref для проверки состояния внутри коллбэков,
  // чтобы избежать stale closure при auto-reconnect
  const connectedRef = useRef(false)
  const startingRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // startRef хранит актуальную версию start для вызова из таймера reconnect
  const startRef = useRef<() => Promise<void>>()

  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('')

  // --- Отправить текст как сообщение пользователя (fallback, не для tool results) ---
  const sendText = useCallback((text: string) => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }))
    dc.send(JSON.stringify({
      type: 'response.create',
      response: {},
    }))
  }, [])

  // --- Вернуть результат tool call в AI ---
  // AI получает результат как function_call_output, а не как слова пользователя.
  // После этого он сам формулирует ответ своими словами.
  const sendFunctionResult = useCallback((callId: string, output: string) => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    }))
    dc.send(JSON.stringify({
      type: 'response.create',
      response: {},
    }))
  }, [])

  // --- Доставить результат анализа без предшествующего tool call ---
  // Используется для путей где AI сам не инициировал захват (ручная кнопка,
  // keyword fallback). Создаём синтетический function_call + function_call_output
  // чтобы AI получил данные как результат инструмента, а не как слова пользователя.
  const sendAnalysisResult = useCallback((result: unknown) => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return

    const callId = `synth_${Date.now()}`

    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call',
        call_id: callId,
        name: 'take_photo_and_analyze',
        arguments: JSON.stringify({ reason: 'автоматический анализ' }),
      },
    }))
    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result),
      },
    }))
    dc.send(JSON.stringify({
      type: 'response.create',
      response: {},
    }))
  }, [])

  // --- Прервать текущий ответ AI (если пользователь перебил) ---
  const cancelResponse = useCallback(() => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify({ type: 'response.cancel' }))
  }, [])

  const start = useCallback(async () => {
    if (connectedRef.current || startingRef.current) return
    startingRef.current = true

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    // Страховка: если старый PC остался (не был закрыт в failed handler), убиваем его
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
      dcRef.current = null
    }

    try {
      setStatus('starting realtime')

      const { token, realtimeUrl, model } = await fetchRealtimeToken()

      const stream = await mediaDevices.getUserMedia({ audio: true, video: false }) as MediaStream
      streamRef.current = stream

      InCallManager.start({ media: 'audio' })
      InCallManager.setSpeakerphoneOn(true)

      const pc = new RTCPeerConnection()
      pcRef.current = pc

      pc.onconnectionstatechange = () => {
        const state = (pc as unknown as { connectionState: string }).connectionState

        if (state === 'connected') {
          connectedRef.current = true
          startingRef.current = false
          setConnected(true)
          setStatus('realtime connected')
        }

        // disconnected — временный провал (WiFi моргнул), ICE может восстановиться.
        // Просто показываем статус, не трогаем reconnect.
        if (state === 'disconnected') {
          connectedRef.current = false
          setConnected(false)
          setStatus('realtime disconnected — waiting for recovery...')
        }

        // failed — ICE не восстановился, нужен полный reconnect.
        // Закрываем старый PC перед стартом нового.
        if (state === 'failed') {
          connectedRef.current = false
          startingRef.current = false
          setConnected(false)
          setStatus('realtime failed — reconnecting in 3s')
          pc.close()
          streamRef.current?.getTracks().forEach((t) => t.stop())
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

      // session.update отправляется только после session.created от Azure.
      // dc.onopen срабатывает когда data channel открыт, но Azure-сессия
      // на бэкенде ещё не инициализирована — session.update в этот момент
      // молча игнорируется. session.created — сигнал что сессия готова.
      dc.onopen = () => {
        dlog('RT', 'dc.onopen — waiting for session.created')
      }

      dc.onmessage = (event) => {
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(event.data as string)
        } catch {
          return
        }

        const type = payload.type as string | undefined

        // Логируем все события кроме audio delta (слишком шумно)
        if (type !== 'response.audio.delta') {
          dlog('DC', JSON.stringify(payload).slice(0, 300))
        }

        // --- Ждём session.created, затем конфигурируем сессию ---
        if (type === 'session.created') {
          dlog('RT', 'session.created — sending session.update')
          dc.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions: ALEX_SYSTEM_PROMPT,
              tools: [TAKE_PHOTO_TOOL],
              tool_choice: 'auto',
            },
          }))
        }

        if (type === 'session.updated') {
          const sess = payload.session as Record<string, unknown> | undefined
          const toolCount = (sess?.tools as unknown[] | undefined)?.length ?? 0
          dlog('RT', 'session.updated tools:', toolCount, 'instructions len:', (sess?.instructions as string)?.length ?? 0)
        }
        if (type === 'error') {
          dlog('RT', 'ERROR from Azure:', JSON.stringify(payload))
        }

        // --- Транскрипт ответа AI (накопительно) ---
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

        // --- Транскрипт пользователя ---
        if (type === 'conversation.item.input_audio_transcription.completed') {
          const text = (payload.transcript as string) || ''
          if (text) onUserTranscript(text)
        }

        // --- Tool call: AI решил сделать фото ---
        if (type === 'response.function_call_arguments.done') {
          const callId = (payload.call_id as string) || ''
          const name = (payload.name as string) || ''
          let args: Record<string, unknown> = {}
          try { args = JSON.parse((payload.arguments as string) || '{}') } catch {}
          if (callId && name) onToolCall(name, callId, args)
        }

        // Отфильтровать шумные события
        const noisy =
          type === 'response.output_audio_transcript.delta' ||
          type === 'response.content_part.added' ||
          type === 'response.audio.delta'
        if (!noisy) onEvent(payload)
      }

      const offer = await pc.createOffer({})
      await pc.setLocalDescription(offer)

      const sdpResp = await fetch(`${realtimeUrl}?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/sdp',
        },
        body: (pc.localDescription as RTCSessionDescription).sdp,
      })

      if (!sdpResp.ok) {
        throw new Error(`SDP error ${sdpResp.status}: ${await sdpResp.text()}`)
      }

      const answerSdp = await sdpResp.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp } as RTCSessionDescriptionInit)
      setStatus('realtime negotiating')
    } catch (err: unknown) {
      startingRef.current = false
      connectedRef.current = false
      const message = err instanceof Error ? err.message : String(err)
      setStatus(`realtime error: ${message}`)
      setConnected(false)
      pcRef.current?.close()
      pcRef.current = null
      InCallManager.stop()
      // При ошибке (нет сети, токен истёк и т.д.) — retry через 5s
      reconnectTimerRef.current = setTimeout(() => startRef.current?.(), 5000)
    }
  }, [onTranscriptDelta, onTranscriptDone, onUserTranscript, onToolCall, onEvent])

  // Держим ref актуальным — таймер reconnect всегда зовёт последнюю версию
  startRef.current = start

  const stop = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    connectedRef.current = false
    startingRef.current = false
    dcRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    InCallManager.stop()
    setConnected(false)
    setStatus('realtime stopped')
  }, [])

  return { connected, status, start, stop, sendText, sendFunctionResult, sendAnalysisResult, cancelResponse }
}
