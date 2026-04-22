import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Image,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native'
import { CameraView } from 'expo-camera'
import { useCamera } from '../hooks/useCamera'
import { useWebSocket } from '../hooks/useWebSocket'
import { useRealtime } from '../hooks/useRealtime'
import { uploadImageForAnalysis, postEvent, type AnalysisResult } from '../lib/api'
import { buildEnvelope, createId } from '../lib/eventBus'
import { inferIntentFromText } from '../lib/intent'
import { LOCAL_CAPTURE_COOLDOWN_MS, RECENT_EVENTS_LIMIT, INTENT_DEDUP_TTL_MS } from '../config'
import { dlog } from '../lib/debugLog'

type AppEvent = Record<string, unknown>

export default function MainScreen() {
  const sessionId = useMemo(() => createId('session'), [])

  const [capturedUri, setCapturedUri] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [status, setStatus] = useState('idle')
  const [events, setEvents] = useState<AppEvent[]>([])
  const [realtimeTranscript, setRealtimeTranscript] = useState('')
  const [transcriptHistory, setTranscriptHistory] = useState<{ responseId: string; text: string }[]>([])

  const lastCaptureTriggerRef = useRef(0)
  const intentDedupRef = useRef<Record<string, number>>({})
  // refs для вызова методов realtime из коллбэков объявленных выше него
  const sendFunctionResultRef = useRef<(callId: string, output: string) => void>(() => {})
  const sendAnalysisResultRef = useRef<(result: unknown) => void>(() => {})
  // Глобальный guard — исключает параллельный захват фото из разных путей
  const isCapturingRef = useRef(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)

  const addEvent = useCallback((event: AppEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, RECENT_EVENTS_LIMIT))
  }, [])

  const pushTranscriptHistory = useCallback((entry: { responseId: string; text: string }) => {
    setTranscriptHistory((prev) => {
      const head = prev[0]
      if (head?.responseId === entry.responseId && head?.text === entry.text) return prev
      return [entry, ...prev].slice(0, 20)
    })
  }, [])

  // --- Camera ---
  const { cameraRef, facing, hasPermission, requestPermission, takePhoto } = useCamera()

  const autoCaptureAndAnalyze = useCallback(async (correlationId: string, causationId: string) => {
    if (!cameraReady) {
      setStatus('auto capture skipped: camera not ready')
      return
    }
    if (isCapturingRef.current) {
      addEvent({ type: 'capture.skipped.concurrent', payload: { reason: 'already capturing' } })
      return
    }
    isCapturingRef.current = true
    setIsAnalyzing(true)
    const uri = await takePhoto()
    if (!uri) {
      setIsAnalyzing(false)
      setStatus('auto capture skipped: camera unavailable')
      return
    }
    setCapturedUri(uri)
    setStatus('auto capture completed')

    await postEvent(buildEnvelope('image.captured', sessionId, { source: 'camera', mode: 'auto' }, correlationId, causationId))

    try {
      const result = await uploadImageForAnalysis(uri, sessionId, correlationId, causationId)
      setAnalysis(result)
      setStatus('auto analysis received')
      sendAnalysisResultRef.current(result)
    } catch (err: unknown) {
      setStatus('analysis error: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      isCapturingRef.current = false
      setIsAnalyzing(false)
    }
  }, [sessionId, takePhoto, cameraReady, addEvent])

  const maybeTriggerCapture = useCallback((reason: string, correlationId: string, causationId: string) => {
    const now = Date.now()
    if (now - lastCaptureTriggerRef.current < LOCAL_CAPTURE_COOLDOWN_MS) {
      addEvent({ type: 'capture.local.skipped.cooldown', payload: { reason } })
      return
    }
    lastCaptureTriggerRef.current = now
    addEvent({ type: 'capture.local.triggered', payload: { reason } })
    autoCaptureAndAnalyze(correlationId, causationId).catch((err: unknown) => {
      setStatus('auto capture error: ' + (err instanceof Error ? err.message : String(err)))
    })
  }, [addEvent, autoCaptureAndAnalyze])

  // --- Tool call handler ---
  // AI вызывает take_photo_and_analyze самостоятельно, когда считает нужным.
  // Результат возвращается как function_call_output — AI получает данные,
  // а не слышит их как слова пользователя, и сам формулирует ответ.
  const handleToolCall = useCallback(async (
    name: string,
    callId: string,
    args: Record<string, unknown>,
  ) => {
    if (name !== 'take_photo_and_analyze') return

    if (isCapturingRef.current) {
      // Уже идёт захват (keyword fallback), возвращаем ошибку в AI чтобы он подождал
      sendFunctionResultRef.current(callId, JSON.stringify({ error: 'Камера уже используется, попробуй через секунду.' }))
      return
    }

    isCapturingRef.current = true
    addEvent({ type: 'tool_call.started', payload: { name, callId, args } })
    setIsAnalyzing(true)

    try {
      const uri = await takePhoto()
      if (!uri) {
        sendFunctionResultRef.current(callId, JSON.stringify({ error: 'Камера недоступна. Попробуй позже.' }))
        return
      }
      setCapturedUri(uri)

      const correlationId = createId('corr')
      const result = await uploadImageForAnalysis(uri, sessionId, correlationId, callId)
      setAnalysis(result)

      // Передаём результат AI — он сам решает как об этом рассказать
      sendFunctionResultRef.current(callId, JSON.stringify(result))
      addEvent({ type: 'tool_call.completed', payload: { callId, species: result.species } })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendFunctionResultRef.current(callId, JSON.stringify({ error: message }))
      addEvent({ type: 'tool_call.error', payload: { callId, error: message } })
      setStatus('tool call error: ' + message)
    } finally {
      isCapturingRef.current = false
      setIsAnalyzing(false)
    }
  }, [sessionId, takePhoto, addEvent])

  const handleIntentFromTranscript = useCallback((text: string, source: string) => {
    const inferred = inferIntentFromText(text)
    if (!inferred) {
      addEvent({ type: 'intent.no_match', payload: { source, text } })
      return
    }

    const dedupKey = `${sessionId}:${source}:${inferred.intent}`
    const lastTs = intentDedupRef.current[dedupKey] || 0
    if (Date.now() - lastTs <= INTENT_DEDUP_TTL_MS) return
    intentDedupRef.current[dedupKey] = Date.now()

    const envelope = buildEnvelope('intent.detected', sessionId, {
      intent: inferred.intent,
      confidence: inferred.confidence,
      transcriptText: text,
      source,
    })
    addEvent({ type: 'intent.inferred', payload: { source, intent: inferred.intent, confidence: inferred.confidence, text } })
    postEvent(envelope).catch(() => {})

    const isVisual = inferred.intent === 'identify_plant' || inferred.intent === 'diagnose_plant'
    if (isVisual) {
      maybeTriggerCapture(`intent:${inferred.intent}:${source}`, envelope.correlationId, envelope.messageId)
    }
  }, [sessionId, addEvent, maybeTriggerCapture])

  // --- Realtime ---
  const realtime = useRealtime({
    onTranscriptDelta: setRealtimeTranscript,
    onTranscriptDone: (responseId, text) => {
      dlog('UI', 'AI transcript done:', text.slice(0, 120))
      setRealtimeTranscript(text)
      pushTranscriptHistory({ responseId, text })
    },
    onUserTranscript: (text) => {
      dlog('UI', 'user transcript:', text)
      pushTranscriptHistory({ responseId: `user-${Date.now()}`, text })
      // Fallback: keyword-matching на случай если AI не вызвал tool call
      handleIntentFromTranscript(text, 'realtime_user_audio')
    },
    onToolCall: (name, callId, args) => {
      dlog('UI', 'tool call received:', name, callId, JSON.stringify(args))
      handleToolCall(name, callId, args)
    },
    onEvent: (ev) => {
      dlog('EV', (ev.type as string) || 'unknown', JSON.stringify(ev).slice(0, 200))
      addEvent(ev)
    },
  })

  // Держим refs актуальными — коллбэки объявленные выше realtime используют их
  sendFunctionResultRef.current = realtime.sendFunctionResult
  sendAnalysisResultRef.current = realtime.sendAnalysisResult

  // --- WebSocket ---
  // analysis.completed намеренно не обрабатывается: результат анализа всегда
  // приходит через HTTP ответ и доставляется в AI через sendAnalysisResult /
  // sendFunctionResult. WS push — всегда дубль, его игнорируем.
  const handleWsMessage = useCallback((msg: Record<string, unknown>) => {
    addEvent(msg)
    const type = msg.type as string | undefined

    if (type === 'analysis.failed') {
      setStatus(`analysis failed: ${(msg?.payload as Record<string, unknown>)?.error || 'unknown'}`)
    }
    if (type === 'capture.requested') {
      maybeTriggerCapture(
        'orchestrator:capture.requested',
        (msg.correlationId as string) || createId('corr'),
        (msg.messageId as string) || createId('cause'),
      )
    }
    if (type === 'assistant.prompt') {
      const promptText = ((msg.payload as Record<string, unknown>)?.text as string) || 'Please provide a clearer plant image.'
      setStatus(`assistant prompt: ${promptText}`)
      realtime.sendText(promptText)
    }
  }, [addEvent, realtime, maybeTriggerCapture])

  const ws = useWebSocket({ sessionId, onMessage: handleWsMessage })

  // --- Auto-start: WS и Realtime поднимаются сразу при монтировании ---
  useEffect(() => {
    dlog('APP', '=== mount, session:', sessionId, '===')
    ws.connect()
    realtime.start()
    return () => {
      realtime.stop()
      ws.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Логируем изменения статуса подключения
  useEffect(() => { dlog('APP', 'realtime connected:', realtime.connected, 'status:', realtime.status) }, [realtime.connected, realtime.status])
  useEffect(() => { dlog('APP', 'ws connected:', ws.connected) }, [ws.connected])

  // --- Manual capture & send ---
  const handleCaptureAndSend = useCallback(async () => {
    if (!cameraReady) {
      setStatus('camera not ready yet')
      return
    }
    setIsAnalyzing(true)
    const uri = await takePhoto()
    if (!uri) {
      setIsAnalyzing(false)
      setStatus('capture failed: no image returned')
      return
    }
    setCapturedUri(uri)
    setStatus('sending image…')
    try {
      const correlationId = createId('corr')
      const result = await uploadImageForAnalysis(uri, sessionId, correlationId, createId('cause'))
      setAnalysis(result)
      setStatus('analysis received')
      realtime.sendAnalysisResult(result)
    } catch (err: unknown) {
      setStatus('analysis error: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsAnalyzing(false)
    }
  }, [sessionId, takePhoto, cameraReady, realtime])

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.permText}>Нужен доступ к камере</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Разрешить</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>GardenAI</Text>
        <Text style={styles.meta}>session: {sessionId.slice(0, 20)}…</Text>

        {/* Camera */}
        <View style={styles.cameraContainer}>
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing={facing}
            onCameraReady={() => setCameraReady(true)}
          />
          {isAnalyzing && (
            <View style={styles.analyzingOverlay}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.analyzingText}>Алекс смотрит…</Text>
            </View>
          )}
        </View>

        {/* Controls */}
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.btn, !cameraReady && styles.btnDisabled]}
            onPress={handleCaptureAndSend}
            disabled={!cameraReady}
          >
            <Text style={styles.btnText}>{cameraReady ? 'Снять и отправить' : 'Камера инициализируется…'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.btn, ws.connected && styles.btnActive]}
            onPress={ws.connected ? ws.disconnect : ws.connect}
          >
            <Text style={styles.btnText}>WS {ws.connected ? 'Disconnect' : 'Connect'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, realtime.connected && styles.btnActive]}
            onPress={realtime.connected ? realtime.stop : realtime.start}
          >
            <Text style={styles.btnText}>Realtime {realtime.connected ? 'Stop' : 'Start'}</Text>
          </TouchableOpacity>
        </View>

        {/* Status */}
        <View style={styles.section}>
          <Text style={styles.label}>Статус: <Text style={styles.value}>{status || realtime.status}</Text></Text>
          <Text style={styles.label}>WS: <Text style={styles.value}>{ws.connected ? 'connected' : 'disconnected'}</Text></Text>
          <Text style={styles.label}>Realtime: <Text style={styles.value}>{realtime.connected ? 'connected' : 'disconnected'}</Text></Text>
        </View>

        {/* Captured photo */}
        {capturedUri && (
          <View style={styles.section}>
            <Text style={styles.label}>Снимок:</Text>
            <Image source={{ uri: capturedUri }} style={styles.capture} />
          </View>
        )}

        {/* Transcript */}
        <View style={styles.section}>
          <Text style={styles.label}>Ассистент:</Text>
          <Text style={styles.pre}>{realtimeTranscript || '…'}</Text>
        </View>

        {/* User transcript history */}
        <View style={styles.section}>
          <Text style={styles.label}>История ({transcriptHistory.length}):</Text>
          {transcriptHistory.slice(0, 6).map((entry) => {
            const isUser = entry.responseId.startsWith('user-')
            return (
              <Text
                key={entry.responseId}
                style={[styles.pre, { marginTop: 2, color: isUser ? '#1a5276' : '#1e8449' }]}
              >
                {isUser ? '🎤 ' : '🤖 '}{entry.text}
              </Text>
            )
          })}
        </View>

        {/* Analysis */}
        {analysis && (
          <View style={styles.section}>
            <Text style={styles.label}>Анализ:</Text>
            <Text style={styles.pre}>{JSON.stringify(analysis, null, 2)}</Text>
          </View>
        )}

        {/* Events */}
        <View style={styles.section}>
          <Text style={styles.label}>События ({events.length}):</Text>
          <Text style={styles.pre}>{JSON.stringify(events.slice(0, 5), null, 2)}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  meta: { fontSize: 11, color: '#888', marginBottom: 12 },
  cameraContainer: { width: '100%', height: 280, borderRadius: 8, overflow: 'hidden', marginBottom: 12 },
  camera: { width: '100%', height: 280, backgroundColor: '#000' },
  analyzingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  analyzingText: { color: '#fff', marginTop: 12, fontSize: 16, fontWeight: '600', letterSpacing: 0.3 },
  capture: { width: '100%', height: 200, borderRadius: 8, resizeMode: 'contain', marginTop: 8 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  btn: { flex: 1, backgroundColor: '#2d6a4f', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnActive: { backgroundColor: '#1b4332' },
  btnDisabled: { backgroundColor: '#aaa' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  permText: { fontSize: 16, marginBottom: 16, textAlign: 'center' },
  section: { marginTop: 16 },
  label: { fontSize: 13, fontWeight: '600', color: '#333' },
  value: { fontWeight: '400', color: '#555' },
  pre: { fontFamily: 'monospace', fontSize: 11, color: '#333', marginTop: 4, backgroundColor: '#f5f5f5', padding: 8, borderRadius: 6 },
})
