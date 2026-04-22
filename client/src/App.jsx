import React, { useMemo, useRef, useState } from 'react'
import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'
const WS_BASE = API_BASE.replace(/^http/i, 'ws')
const REALTIME_TOKEN_AUTH_HEADER = 'x-gardenai-realtime-token-secret'
const REALTIME_TOKEN_AUTH_SECRET = import.meta.env.VITE_REALTIME_TOKEN_AUTH_SECRET || ''
const REALTIME_TRANSCRIBE_MODEL = import.meta.env.VITE_REALTIME_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
const RECENT_EVENTS_LIMIT = 40
const LOCAL_CAPTURE_COOLDOWN_MS = 6000
const ENABLE_LOCAL_SPEECH = false

function createId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

export default function App() {
  const videoRef = useRef(null)
  const wsRef = useRef(null)
  const realtimePcRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const realtimeRetryRef = useRef(0)
  const realtimeStartRef = useRef(0)
  const audioLevelIntervalRef = useRef(null)
  const realtimeDcRef = useRef(null)
  const intentDedupRef = useRef({})
  const assistantCaptureFallbackRef = useRef(0)
  const localSpeechRef = useRef(null)
  const localSpeechActiveRef = useRef(false)
  const lastCaptureTriggerRef = useRef(0)

  const [stream, setStream] = useState(null)
  const [capturedUrl, setCapturedUrl] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [status, setStatus] = useState('idle')
  const [wsConnected, setWsConnected] = useState(false)
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const [events, setEvents] = useState([])
  const [micLevel, setMicLevel] = useState(0)
  const [realtimeTranscript, setRealtimeTranscript] = useState('')
  const [transcriptHistory, setTranscriptHistory] = useState([])

  const sessionId = useMemo(() => createId('session'), [])
  const transcriptBufferRef = useRef({})
  const userTranscriptBufferRef = useRef({})

  function addEvent(event) {
    setEvents((prev) => [event, ...prev].slice(0, RECENT_EVENTS_LIMIT))
  }

  function isNoisyRealtimeEvent(payload) {
    const type = payload?.type || ''
    return (
      type === 'response.output_audio_transcript.delta' ||
      type === 'response.content_part.added'
    )
  }

  function pushTranscriptHistory(entry) {
    setTranscriptHistory((prev) => {
      const head = prev[0]
      if (head && head.responseId === entry.responseId && head.text === entry.text) {
        return prev
      }
      return [entry, ...prev].slice(0, 20)
    })
  }

  function handleIntentFromTranscript(text, source) {
    const inferred = inferIntentFromText(text)
    if (!inferred) return
    const dedupKey = `${sessionId}:${source}:${inferred.intent}`
    const lastTs = intentDedupRef.current[dedupKey] || 0
    if (Date.now() - lastTs <= 3000) return

    intentDedupRef.current[dedupKey] = Date.now()
    const intentEvent = {
      messageId: createId('evt'),
      type: 'intent.detected',
      sessionId,
      correlationId: createId('corr'),
      causationId: createId('cause'),
      tsWallIso: new Date().toISOString(),
      schemaVersion: '1.0',
      payload: {
        intent: inferred.intent,
        confidence: inferred.confidence,
        transcriptText: text,
        source
      }
    }
    addEvent({
      type: 'intent.inferred',
      payload: { source, intent: inferred.intent, confidence: inferred.confidence, text }
    })
    postEventToBus(intentEvent)

    const isVisualIntent =
      inferred.intent === 'identify_plant' || inferred.intent === 'diagnose_plant'
    if (isVisualIntent) {
      maybeTriggerLocalCapture(`intent:${inferred.intent}:${source}`, intentEvent.correlationId, intentEvent.messageId)
    }
  }

  function maybeTriggerLocalCapture(reason, correlationId, causationId) {
    const now = Date.now()
    if (now - lastCaptureTriggerRef.current < LOCAL_CAPTURE_COOLDOWN_MS) {
      addEvent({ type: 'capture.local.skipped.cooldown', payload: { reason } })
      return
    }
    lastCaptureTriggerRef.current = now
    addEvent({ type: 'capture.local.triggered', payload: { reason } })
    autoCaptureAndAnalyze(correlationId, causationId).catch((err) => {
      setStatus('auto capture error: ' + err.message)
    })
  }

  function inferIntentFromText(text) {
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

  function assistantRequestsPhoto(text) {
    const normalized = String(text || '').toLowerCase()
    if (!normalized) return false
    const photoPattern = /(пришли|отправь|покаж|показа|наведи).{0,28}(фото|снимок|камер)/
    return (
      photoPattern.test(normalized) ||
      normalized.includes('пришли фото') ||
      normalized.includes('покажи фото') ||
      normalized.includes('покажи снимок') ||
      normalized.includes('отправь фото') ||
      normalized.includes('отправь мне фото') ||
      normalized.includes('передай снимок') ||
      normalized.includes('наведи камеру') ||
      normalized.includes('покажи растение') ||
      normalized.includes('пришли мне фото') ||
      normalized.includes('пожалуйста, пришли фото') ||
      normalized.includes('просто отправь мне фото') ||
      normalized.includes('show a photo') ||
      normalized.includes('show me the camera') ||
      normalized.includes('point the camera') ||
      normalized.includes('send a photo') ||
      normalized.includes('upload a photo') ||
      normalized.includes('show me the plant')
    )
  }

  function startLocalSpeechIntentDetection() {
    if (localSpeechActiveRef.current) return
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      addEvent({ type: 'speech.local.unsupported' })
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'ru-RU'
    recognition.continuous = true
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        if (!result.isFinal) continue
        const text = result[0]?.transcript?.trim()
        if (!text) continue
        pushTranscriptHistory({ responseId: `local-speech-${Date.now()}`, text })
        handleIntentFromTranscript(text, 'local_speech')
      }
    }
    recognition.onerror = (event) => {
      addEvent({ type: 'speech.local.error', payload: { error: event.error } })
    }
    recognition.onend = () => {
      if (localSpeechActiveRef.current) {
        try {
          recognition.start()
        } catch {
          // ignore rapid restart errors
        }
      }
    }

    try {
      recognition.start()
      localSpeechRef.current = recognition
      localSpeechActiveRef.current = true
      addEvent({ type: 'speech.local.started', payload: { lang: recognition.lang } })
    } catch (err) {
      addEvent({ type: 'speech.local.start.error', payload: { error: err.message } })
    }
  }

  function stopLocalSpeechIntentDetection() {
    localSpeechActiveRef.current = false
    const recognition = localSpeechRef.current
    localSpeechRef.current = null
    if (recognition) {
      try {
        recognition.stop()
      } catch {
        // ignore stop errors
      }
    }
    addEvent({ type: 'speech.local.stopped' })
  }

  async function postEventToBus(event) {
    try {
      await axios.post(`${API_BASE}/api/events`, event)
    } catch (err) {
      addEvent({
        type: 'event.publish.error',
        payload: err?.response?.data || { error: err.message, failedType: event.type }
      })
    }
  }

  function summarizeAnalysis(payload) {
    const species = payload?.species || 'unknown'
    const urgency = payload?.urgency || 'unknown'
    const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions.slice(0, 3).join('; ') : ''
    return `Plant analysis result. Species: ${species}. Urgency: ${urgency}. Suggestions: ${suggestions || 'none'}.`
  }

  function sendRealtimeText(text) {
    const dc = realtimeDcRef.current
    if (!dc || dc.readyState !== 'open') return
    try {
      dc.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }]
          }
        })
      )
      dc.send(
        JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio', 'text'] }
        })
      )
    } catch (err) {
      addEvent({ type: 'realtime.send.error', payload: err.message })
    }
  }

  async function autoCaptureAndAnalyze(correlationId, causationId) {
    const video = videoRef.current
    if (!video) {
      setStatus('auto capture skipped: camera unavailable')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg')
    setCapturedUrl(dataUrl)
    setStatus('auto capture completed')

    const imageCapturedEvent = {
      messageId: createId('evt'),
      type: 'image.captured',
      sessionId,
      correlationId: correlationId || createId('corr'),
      causationId: causationId || createId('cause'),
      tsWallIso: new Date().toISOString(),
      schemaVersion: '1.0',
      payload: {
        source: 'camera',
        mode: 'auto'
      }
    }
    await postEventToBus(imageCapturedEvent)

    const r = await fetch(dataUrl)
    const blob = await r.blob()
    const fd = new FormData()
    fd.append('image', blob, 'auto-capture.jpg')
    fd.append('sessionId', sessionId)
    fd.append('correlationId', imageCapturedEvent.correlationId)
    fd.append('causationId', imageCapturedEvent.messageId)
    const response = await axios.post(`${API_BASE}/api/analyze-image`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    setAnalysis(response.data)
    setStatus('auto analysis received')
  }

  async function startCamera() {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      videoRef.current.srcObject = media
      videoRef.current.play()
      setStream(media)
      setStatus('camera started')
    } catch (err) {
      setStatus('camera error: ' + err.message)
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      setStream(null)
      setStatus('camera stopped')
    }
  }

  function capturePhoto() {
    const video = videoRef.current
    if (!video) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    setCapturedUrl(canvas.toDataURL('image/jpeg'))
    setStatus('photo captured')
  }

  async function connectWs() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${encodeURIComponent(sessionId)}`)
    wsRef.current = ws

    ws.onopen = () => {
      setWsConnected(true)
      setStatus('ws connected')
    }

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data)
        addEvent(data)
        if (data.type === 'analysis.completed') {
          setAnalysis(data.payload)
          setStatus('analysis completed (ws)')
          sendRealtimeText(summarizeAnalysis(data.payload))
        }
        if (data.type === 'analysis.failed') {
          setStatus(`analysis failed: ${data?.payload?.error || 'unknown error'}`)
        }
        if (data.type === 'capture.requested') {
          const now = Date.now()
          if (now - lastCaptureTriggerRef.current < LOCAL_CAPTURE_COOLDOWN_MS) {
            addEvent({ type: 'capture.requested.skipped.local-cooldown', payload: { correlationId: data.correlationId } })
          } else {
            maybeTriggerLocalCapture('orchestrator:capture.requested', data.correlationId, data.messageId)
          }
        }
        if (data.type === 'assistant.prompt') {
          const promptText = data?.payload?.text || 'Please provide a clearer plant image.'
          setStatus(`assistant prompt: ${promptText}`)
          sendRealtimeText(promptText)
        }
      } catch (err) {
        setStatus('ws message parse error: ' + err.message)
      }
    }

    ws.onclose = () => {
      setWsConnected(false)
      wsRef.current = null
      setStatus('ws disconnected')
    }

    ws.onerror = () => {
      setStatus('ws error')
    }
  }

  function disconnectWs() {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setWsConnected(false)
  }

  async function sendForAnalysis() {
    if (!capturedUrl) return
    setStatus('sending image')

    try {
      const r = await fetch(capturedUrl)
      const blob = await r.blob()
      const fd = new FormData()
      const correlationId = createId('corr')
      fd.append('image', blob, 'capture.jpg')
      fd.append('sessionId', sessionId)
      fd.append('correlationId', correlationId)
      fd.append('causationId', createId('cause'))

      const response = await axios.post(`${API_BASE}/api/analyze-image`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      setAnalysis(response.data)
      setStatus('analysis received')
    } catch (err) {
      setStatus('analysis error: ' + err.message)
    }
  }

  async function startRealtime() {
    if (realtimeConnected) return

    try {
      setStatus('starting realtime')
      const tokenResp = await axios.get(`${API_BASE}/api/realtime-token`, {
        headers: REALTIME_TOKEN_AUTH_SECRET
          ? { [REALTIME_TOKEN_AUTH_HEADER]: REALTIME_TOKEN_AUTH_SECRET }
          : undefined
      })
      const { token, realtimeUrl, model } = tokenResp.data
      if (!token || !realtimeUrl || !model) {
        throw new Error('invalid realtime token payload')
      }

      let media = stream
      if (!media) {
        media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        setStream(media)
        if (videoRef.current) {
          videoRef.current.srcObject = media
          videoRef.current.play()
        }
      }

      const pc = new RTCPeerConnection()
      realtimePcRef.current = pc

      const remoteAudio = new Audio()
      remoteAudio.autoplay = true
      remoteAudioRef.current = remoteAudio

      pc.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0]
        remoteAudio.play().catch(() => {})
      }

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          realtimeRetryRef.current = 0
          setRealtimeConnected(true)
          const elapsed = realtimeStartRef.current ? Date.now() - realtimeStartRef.current : null
          setStatus(elapsed ? `realtime connected (${elapsed} ms)` : 'realtime connected')
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setRealtimeConnected(false)
          setStatus(`realtime ${pc.connectionState}`)
          if (realtimeRetryRef.current < 1) {
            realtimeRetryRef.current += 1
            if (realtimePcRef.current) {
              realtimePcRef.current.close()
              realtimePcRef.current = null
            }
            setTimeout(() => {
              startRealtime().catch(() => {})
            }, 700)
          }
        }
      }

      media.getAudioTracks().forEach((track) => {
        pc.addTrack(track, media)
      })

      const dataChannel = pc.createDataChannel('garden-events')
      realtimeDcRef.current = dataChannel
      dataChannel.onopen = () => {
        try {
          dataChannel.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                audio: {
                  input: {
                    transcription: { model: REALTIME_TRANSCRIBE_MODEL }
                  }
                }
              }
            })
          )
          addEvent({
            type: 'realtime.session.update.sent',
            payload: { inputAudioTranscriptionModel: REALTIME_TRANSCRIBE_MODEL }
          })
        } catch (err) {
          addEvent({ type: 'realtime.session.update.error', payload: err.message })
        }
      }
      dataChannel.onmessage = (event) => {
        let payload = event.data
        try {
          payload = JSON.parse(event.data)
        } catch {
          // keep raw string
        }
        if (!isNoisyRealtimeEvent(payload)) {
          addEvent({ type: 'realtime.event', payload })
        }

        if (payload && payload.type) {
          if (payload.type === 'session.updated') {
            addEvent({
              type: 'realtime.session.updated',
              payload: {
                hasInputTranscription: Boolean(payload?.session?.audio?.input?.transcription)
              }
            })
          }

          if (payload.type === 'conversation.item.input_audio_transcription.delta') {
            const itemId = payload.item_id || 'user-audio'
            const current = userTranscriptBufferRef.current[itemId] || ''
            userTranscriptBufferRef.current[itemId] = current + (payload.delta || '')
          }

          if (payload.type === 'conversation.item.input_audio_transcription.completed') {
            const text = payload.transcript || ''
            if (text) {
              pushTranscriptHistory({ responseId: payload.item_id || 'user-audio', text })
              handleIntentFromTranscript(text, 'realtime_user_audio')
            }
          }

          if (payload.type === 'conversation.item.done' && payload?.item?.role === 'user') {
            const itemId = payload?.item?.id || 'user-audio'
            const fromDelta = userTranscriptBufferRef.current[itemId] || ''
            const fromContent = (payload?.item?.content || [])
              .map((part) => part?.transcript || part?.text || '')
              .filter(Boolean)
              .join(' ')
              .trim()
            const text = fromContent || fromDelta
            if (text) {
              pushTranscriptHistory({ responseId: itemId, text })
              handleIntentFromTranscript(text, 'realtime_user_item_done')
            }
          }

          if (payload.type === 'response.output_audio_transcript.delta') {
            const responseId = payload.response_id || 'unknown'
            const delta = payload.delta || ''
            const current = transcriptBufferRef.current[responseId] || ''
            const next = current + delta
            transcriptBufferRef.current[responseId] = next
            setRealtimeTranscript(next)
          }

          if (payload.type === 'response.output_audio_transcript.done') {
            const responseId = payload.response_id || 'unknown'
            const text = payload.transcript || transcriptBufferRef.current[responseId] || ''
            if (text) {
              setRealtimeTranscript(text)
              pushTranscriptHistory({ responseId, text })
              if (assistantRequestsPhoto(text)) {
                const now = Date.now()
                if (now - assistantCaptureFallbackRef.current > 8000) {
                  assistantCaptureFallbackRef.current = now
                  addEvent({ type: 'assistant.capture.triggered', payload: { text } })
                  handleIntentFromTranscript('identify plant from current camera frame', 'assistant_fallback')
                  autoCaptureAndAnalyze(createId('corr'), createId('cause')).catch((err) => {
                    setStatus('auto capture fallback error: ' + err.message)
                  })
                }
              }
            }
          }

          if (payload.type === 'response.done' && payload.response) {
            const responseId = payload.response.id || payload.response_id || 'unknown'
            const output = payload.response.output || []
            const content = output[0]?.content || []
            const text =
              content.find((part) => part.type === 'output_audio')?.transcript ||
              content.find((part) => part.type === 'output_text')?.text ||
              payload.response.output_text ||
              transcriptBufferRef.current[responseId] ||
              ''
            if (text) {
              setRealtimeTranscript(text)
              pushTranscriptHistory({ responseId, text })
            }
          }
        }
      }

      const audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(media)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current)
      }
      audioLevelIntervalRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        setMicLevel(Math.min(1, rms * 2))
      }, 200)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const sdpResponse = await fetch(`${realtimeUrl}?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp
      })

      if (!sdpResponse.ok) {
        const details = await sdpResponse.text()
        throw new Error(`realtime sdp error: ${details}`)
      }

      const answer = await sdpResponse.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
      realtimeStartRef.current = Date.now()
      if (ENABLE_LOCAL_SPEECH) {
        startLocalSpeechIntentDetection()
      }
      setStatus('realtime negotiating')
    } catch (err) {
      const details = err?.response?.data?.details || err?.response?.data?.error
      if (details) {
        setStatus(`realtime error: ${err.message} | ${details}`)
      } else {
        setStatus('realtime error: ' + err.message)
      }
      setRealtimeConnected(false)
      if (realtimePcRef.current) {
        realtimePcRef.current.close()
        realtimePcRef.current = null
      }
    }
  }

  function stopRealtime() {
    realtimeRetryRef.current = 0
    realtimeStartRef.current = 0
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current)
      audioLevelIntervalRef.current = null
    }
    if (realtimePcRef.current) {
      realtimePcRef.current.close()
      realtimePcRef.current = null
    }
    realtimeDcRef.current = null
    if (ENABLE_LOCAL_SPEECH) {
      stopLocalSpeechIntentDetection()
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause()
      remoteAudioRef.current.srcObject = null
      remoteAudioRef.current = null
    }
    setRealtimeConnected(false)
    setStatus('realtime stopped')
  }

  return (
    <div>
      <h1>GardenAI - Gardener Agent (Browser)</h1>
      <p>sessionId: {sessionId}</p>

      <div>
        <button onClick={startCamera}>Start Camera</button>
        <button onClick={stopCamera}>Stop Camera</button>
        <button onClick={capturePhoto}>Capture Photo</button>
        <button onClick={sendForAnalysis} disabled={!capturedUrl}>Send For Analysis</button>
      </div>

      <div>
        <button onClick={connectWs} disabled={wsConnected}>Connect WS</button>
        <button onClick={disconnectWs} disabled={!wsConnected}>Disconnect WS</button>
        <button onClick={startRealtime} disabled={realtimeConnected}>Start Realtime</button>
        <button onClick={stopRealtime} disabled={!realtimeConnected}>Stop Realtime</button>
      </div>

      <div style={{ marginTop: 12 }}>
        <video ref={videoRef} autoPlay playsInline muted></video>
      </div>

      {capturedUrl && (
        <div>
          <h3>Captured</h3>
          <img src={capturedUrl} className="capture" alt="captured" />
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <strong>Status:</strong> {status}
      </div>
      <div>
        <strong>WS:</strong> {wsConnected ? 'connected' : 'disconnected'}
      </div>
      <div>
        <strong>Realtime:</strong> {realtimeConnected ? 'connected' : 'disconnected'}
      </div>
      <div>
        <strong>Mic Level:</strong> {(micLevel * 100).toFixed(0)}%
      </div>
      <div style={{ marginTop: 12 }}>
        <h3>Realtime Transcript</h3>
        <pre className="pre">{realtimeTranscript || '...'}</pre>
      </div>
      <div style={{ marginTop: 12 }}>
        <h3>Transcript History</h3>
        <pre className="pre">{JSON.stringify(transcriptHistory, null, 2)}</pre>
      </div>

      {analysis && (
        <div style={{ marginTop: 12 }}>
          <h3>Analysis</h3>
          <pre className="pre">{JSON.stringify(analysis, null, 2)}</pre>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <h3>Recent Events</h3>
        <pre className="pre">{JSON.stringify(events, null, 2)}</pre>
      </div>
    </div>
  )
}
