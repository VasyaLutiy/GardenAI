# GardenAI — Mobile Implementation Plan (React Native)

## 1. Анализ текущего проекта

### Frontend (React + Vite, `client/`)

Один файл `App.jsx` (~770 строк). Использует:

| Функция | Web API / библиотека |
|---|---|
| Камера + видеопоток | `navigator.mediaDevices.getUserMedia` + `<video>` |
| Захват фото | `Canvas API` → `toDataURL()` |
| WebSocket | нативный браузерный `WebSocket` |
| WebRTC (голос) | `RTCPeerConnection` → Azure OpenAI Realtime |
| Аудио-уровень микрофона | `AudioContext` + `createAnalyser` |
| Голосовое распознавание | `window.SpeechRecognition` (отключено, `ENABLE_LOCAL_SPEECH=false`) |
| HTTP-запросы | `axios` |
| ID генерация | `crypto.randomUUID` |
| UI | HTML + CSS |

### Backend (Express + Node.js, `server/`)

Три REST endpoint'а + WebSocket gateway + Redis:

| Endpoint | Назначение |
|---|---|
| `GET /api/realtime-token` | Выдаёт ephemeral token для Azure OpenAI Realtime |
| `POST /api/analyze-image` | Multipart upload → vision worker → результат |
| `POST /api/events` | Event bus (intent, capture, image.captured и др.) |
| `WS /ws?sessionId=` | Push уведомлений от оркестратора к клиенту |

**Инфраструктура:** Redis (Pub/Sub + Streams), Azure OpenAI (Vision + Realtime)

---

## 2. Анализ портируемости

### Что переносится без изменений

| Код | Портируемость |
|---|---|
| `inferIntentFromText()` | ✅ чистый JS, копируется 1-в-1 |
| `handleIntentFromTranscript()` | ✅ чистый JS |
| `postEventToBus()` (axios) | ✅ axios работает в React Native |
| Event envelope логика | ✅ чистый JS |
| WebSocket код | ✅ React Native имеет встроенный `WebSocket` с идентичным API |
| FormData для upload | ✅ работает в RN (с поправкой на URI вместо Blob) |
| Весь **backend** | ✅ без изменений |

### Что требует замены

| Web API | React Native замена | Сложность |
|---|---|---|
| `<video>` + `getUserMedia` | `expo-camera` → `<CameraView>` | Средняя |
| `canvas.toDataURL()` | `camera.takePictureAsync({base64: true})` | Низкая |
| `RTCPeerConnection` | `react-native-webrtc` | **Высокая** |
| `AudioContext` / `analyser` | Пропустить в MVP или использовать `expo-av` | Низкая |
| `window.SpeechRecognition` | Уже отключено (`ENABLE_LOCAL_SPEECH=false`) | — |
| `crypto.randomUUID` | `expo-crypto` | Низкая |
| HTML/CSS | RN компоненты (`View`, `Text`, `StyleSheet`) | Средняя |

---

## 3. Стек мобильного приложения

```
Expo (bare workflow после prebuild)
  ├── expo-camera          — камера + захват фото
  ├── expo-crypto          — UUID генерация
  ├── react-native-webrtc  — RTCPeerConnection для Azure Realtime
  ├── axios                — HTTP (тот же что на web)
  └── @react-navigation/native — навигация (задел на будущее)
```

**Почему Expo:**
- Быстрый старт, OTA-обновления, проверенные нативные модули
- `react-native-webrtc` требует `expo prebuild` (bare workflow) — это единственное исключение из managed workflow

---

## 4. Структура нового мобильного проекта

```
GardenAi/
├── server/                    ← не трогаем
├── client/                    ← не трогаем (web остаётся)
└── mobile/                    ← новый проект
    ├── app.json
    ├── package.json
    ├── App.tsx
    └── src/
        ├── config.ts           ← API_BASE, WS_BASE (из env / app.json extra)
        ├── lib/
        │   ├── api.ts          ← axios вызовы (порт из App.jsx)
        │   ├── intent.ts       ← inferIntentFromText (копия 1-в-1)
        │   └── events.ts       ← createId, buildEnvelope, postEventToBus
        ├── hooks/
        │   ├── useWebSocket.ts ← порт connectWs/disconnectWs/onmessage
        │   ├── useRealtime.ts  ← порт startRealtime (react-native-webrtc)
        │   └── useCamera.ts    ← expo-camera обёртка + захват фото
        └── screens/
            └── MainScreen.tsx  ← UI на RN компонентах
```

---

## 5. Фазы реализации

### Фаза 1 — Foundation (2–3 дня)

- `expo init mobile --template blank-typescript`
- `expo prebuild` для поддержки `react-native-webrtc`
- `src/config.ts` с `API_BASE` через `expo-constants` / `.env`
- Скопировать `inferIntentFromText`, `createId`, event envelope в `src/lib/`
- Настроить axios клиент с базовым URL и таймаутами

### Фаза 2 — Camera & Photo (1–2 дня)

- Интегрировать `expo-camera`
- `useCamera.ts` — запрос разрешений, `takePictureAsync({base64: true})`
- Замена `autoCaptureAndAnalyze()`: вместо Canvas используем `camera.takePictureAsync()`
- Upload через `FormData` с объектом `{uri, type: 'image/jpeg', name: 'capture.jpg'}` вместо Blob

```ts
// Вместо canvas.toDataURL() + fetch(dataUrl) + blob:
const photo = await cameraRef.current.takePictureAsync({ base64: true })
const fd = new FormData()
fd.append('image', { uri: photo.uri, type: 'image/jpeg', name: 'capture.jpg' } as any)
fd.append('sessionId', sessionId)
```

### Фаза 3 — WebSocket (0.5 дня)

- Порт `connectWs/disconnectWs` в `useWebSocket.ts`
- React Native WebSocket API идентичен браузерному — правки минимальны
- Проверить получение `analysis.completed`, `capture.requested`, `assistant.prompt`

### Фаза 4 — WebRTC Realtime (3–4 дня)

- `react-native-webrtc` предоставляет `RTCPeerConnection` с той же API что в браузере
- `mediaDevices.getUserMedia({audio: true})` импортировать из `react-native-webrtc`
- Поток `startRealtime()` почти идентичен: createOffer → setLocalDescription → POST SDP → setRemoteDescription
- Аудио воспроизведение: `react-native-webrtc` управляет нативно, дополнительно `InCallManager` для управления динамиком

```ts
import { RTCPeerConnection, mediaDevices } from 'react-native-webrtc'

const stream = await mediaDevices.getUserMedia({ audio: true, video: false })
const pc = new RTCPeerConnection()
stream.getAudioTracks().forEach(track => pc.addTrack(track, stream))
// далее — идентично web версии
```

### Фаза 5 — UI (2–3 дня)

- `<CameraView ref={cameraRef} style={styles.camera} />` вместо `<video>`
- `<View>`, `<Text>`, `<TouchableOpacity>` вместо div/button
- `<ScrollView>` для event log и transcript history
- `StyleSheet.create()` для стилей
- Индикатор уровня микрофона — простой `<View>` с пропорциональной шириной

---

## 6. Изменения на backend

Backend остаётся без изменений. Единственные правки в конфигурации:

```bash
# server/.env — добавить мобильные origins для разработки
CORS_ORIGIN=http://localhost:8081,exp://192.168.x.x:8081
```

**Для production:**
- HTTPS обязателен для мобильного клиента (iOS ATS, Android cleartext restrictions)
- TLS-терминация через nginx / reverse-proxy перед Express
- Сам Express код не меняется

---

## 7. Главные риски

### WebRTC на мобильном (высокий риск)

`react-native-webrtc` — нативный модуль, требует:
1. `expo prebuild` → генерирует `android/` и `ios/` директории
2. Разрешения в `AndroidManifest.xml`: `RECORD_AUDIO`, `CAMERA`, `INTERNET`
3. Разрешения в `Info.plist`: `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`
4. На iOS — физическое устройство (симулятор не поддерживает аудио WebRTC)

**Fallback:** если WebRTC окажется нестабильным — заменить Azure Realtime на text-based режим:
- Запись аудио через `expo-av` → upload → Azure Speech-to-Text → `/api/events` с транскриптом
- Вся остальная логика (intent detection, orchestrator, vision) остаётся без изменений

### AudioContext / Mic Level (низкий риск)

`AudioContext` отсутствует в React Native. В MVP пропустить визуализацию уровня микрофона. При необходимости реализовать через `expo-av` audio metering API.

---

## 8. Кросс-платформенная совместимость Android / iOS

### 8.1 WebRTC (`react-native-webrtc`) — КРИТИЧНО

Самое уязвимое место всего стека.

| Проблема | Android | iOS |
|---|---|---|
| `.so` выравнивание 16 KB | **Требует проверки** (Google Play дедлайн: Nov 2025) | Не применимо |
| Тест на симуляторе | Работает | **Аудио не работает** — нужно физическое устройство |
| Аудио-маршрутизация (динамик) | Нужен `InCallManager` | Нужен `InCallManager` |
| Разрешения | `RECORD_AUDIO`, `CAMERA` в `AndroidManifest.xml` | `NSMicrophoneUsageDescription` в `Info.plist` |

**Решение аудио-маршрутизации** (добавить в зависимости):
```ts
// npm install react-native-incall-manager
import InCallManager from 'react-native-incall-manager'

// При старте WebRTC (в useRealtime.ts)
InCallManager.start({ media: 'audio' })
InCallManager.setSpeakerphoneOn(true)  // через динамик, не в ухо

// При остановке
InCallManager.stop()
```

**Проверка 16KB alignment перед публикацией в Google Play:**
```bash
zipalign -c -P 16 -v 4 app-release.apk

# Найти нативные библиотеки react-native-webrtc
find node_modules/react-native-webrtc -name "*.so"
```

**CI/CD пайплайн — добавить шаг перед публикацией:**
```bash
zipalign -c -P 16 -v 4 app-release.apk 2>&1 | tee alignment.log
if grep -q "Verification FAILED" alignment.log; then
  echo "16KB alignment check FAILED"
  exit 1
fi
```

---

### 8.2 Сетевая безопасность (HTTP vs HTTPS)

| | Android | iOS |
|---|---|---|
| HTTP в dev | Заблокирован по умолчанию | Заблокирован ATS |
| HTTP для localhost | Разрешён | Разрешён |
| В продакшне | HTTPS обязателен | HTTPS обязателен |

**Android** — `android/app/src/main/res/xml/network_security_config.xml`:
```xml
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">192.168.x.x</domain>
    <domain includeSubdomains="true">10.0.2.2</domain>
  </domain-config>
</network-security-config>
```

Подключить в `AndroidManifest.xml`:
```xml
<application
  android:networkSecurityConfig="@xml/network_security_config"
  ...>
```

**iOS** — `ios/GardenAI/Info.plist` (только для dev):
```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>
```

---

### 8.3 Разрешения камеры и микрофона

**Android** — `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
```

**iOS** — `ios/GardenAI/Info.plist`:
```xml
<key>NSCameraUsageDescription</key>
<string>Нужна камера для анализа растений</string>
<key>NSMicrophoneUsageDescription</key>
<string>Нужен микрофон для голосового помощника</string>
```

**JS-код** — `expo-camera` абстрагирует runtime запрос на обеих платформах:
```ts
const { status } = await Camera.requestCameraPermissionsAsync()
// работает одинаково на Android и iOS
```

---

### 8.4 `crypto.randomUUID` — несовместимость с Hermes

В текущем `App.jsx` используется `crypto.randomUUID` — в Hermes (движок RN по умолчанию) это нестабильно на обеих платформах.

```ts
// НЕ использовать в RN:
crypto.randomUUID()

// Использовать (работает одинаково на Android + iOS):
import * as Crypto from 'expo-crypto'
Crypto.randomUUID()
```

---

### 8.5 FormData + загрузка изображения

Поведение различается, если передавать Blob. Надёжный способ для обеих платформ — передавать URI:

```ts
const photo = await cameraRef.current.takePictureAsync()

const fd = new FormData()
fd.append('image', {
  uri: photo.uri,
  type: 'image/jpeg',   // явно указывать — Android может определить неправильно
  name: 'capture.jpg',
} as any)
```

---

### 8.6 Сводная матрица рисков

| Компонент | Android | iOS | Приоритет |
|---|---|---|---|
| WebRTC аудио-маршрутизация | `InCallManager` | `InCallManager` | КРИТИЧНО |
| 16KB `.so` alignment | Проверить обязательно | — | КРИТИЧНО |
| HTTP в dev | `network_security_config` | `NSAllowsArbitraryLoads` | Высокий |
| Разрешения камеры/микро | `AndroidManifest.xml` | `Info.plist` | Высокий |
| `crypto.randomUUID` | `expo-crypto` | `expo-crypto` | Средний |
| FormData MIME | Явно указывать `type` | Явно указывать `type` | Средний |
| WebRTC на симуляторе | Работает | Не работает — нужен девайс | Средний |

---

## 9. Диаграмма итоговой архитектуры

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│   Mobile App (RN/Expo)  │         │   Backend (без изменений)    │
│                         │         │                              │
│  useCamera              │──HTTP──▶│  POST /api/analyze-image     │
│  useWebSocket           │◀──WS───▶│  WS /ws?sessionId=           │
│  useRealtime (WebRTC)   │──HTTP──▶│  GET /api/realtime-token     │
│  lib/intent.ts          │──HTTP──▶│  POST /api/events            │
│  lib/events.ts          │         │                              │
│                         │         │  Redis (Pub/Sub + Streams)   │
│                         │  WebRTC │  Orchestrator loop           │
│  RTCPeerConnection      │────────▶│  Vision Worker               │
└─────────────────────────┘  Azure  └──────────────────────────────┘
                             Realtime
```

---

## 10. Зависимости мобильного `package.json`

```json
{
  "dependencies": {
    "expo": "~51.0.0",
    "expo-camera": "~15.0.0",
    "expo-crypto": "~13.0.0",
    "expo-constants": "~16.0.0",
    "react": "18.2.0",
    "react-native": "0.74.0",
    "react-native-webrtc": "^124.0.0",
    "react-native-incall-manager": "^4.0.0",
    "axios": "^1.4.0",
    "@react-navigation/native": "^6.0.0",
    "@react-navigation/native-stack": "^6.0.0",
    "react-native-screens": "^3.0.0",
    "react-native-safe-area-context": "^4.0.0"
  }
}
```

---

## 11. Порядок первых шагов

```bash
# 1. Создать Expo проект
npx create-expo-app mobile --template blank-typescript
cd mobile

# 2. Установить зависимости
npx expo install expo-camera expo-crypto expo-constants
npm install react-native-webrtc axios

# 3. Prebuild для нативных модулей
npx expo prebuild

# 4. Запуск
npx expo run:android   # или run:ios
```
