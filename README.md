# GardenAI

GardenAI is a mobile-first plant assistant with split mobile/server visual orchestration.

Overview:
- `Mobile/` - React Native app with a checked-in native Android project under `Mobile/android`. Owns camera access, the local snapshot buffer, realtime tool calls, and the visual UX.
- `server/` - Express API, Redis-backed orchestration, vision worker, storage cleanup, and WebSocket fanout.

Quick start:

Server

```bash
cd server
npm install
cp .env.example .env
npm start
```

Mobile

```bash
cd Mobile
npm install
npm start
```

How to build Android APK

Prereqs:
- Java 17+ installed locally
- Android SDK and platform tools available

Build:
```bash
cd Mobile/android
./gradlew assembleRelease
```

Output:
- `Mobile/android/app/build/outputs/apk/release/app-release.apk`

Notes:
- `expo prebuild` is not required for normal APK builds.
- Only use `expo prebuild` if native Android code or config must be regenerated, since it can rewrite the checked-in native project.
- The current release APK build is suitable for testing, but runtime validation on a device is still recommended.

Backend tests and smoke checks

```bash
cd server
npm test
npm run smoke:events
npm run smoke:ws
```

Notes:
- Visual events use `schemaVersion: 2.0` on the mobile side.
- Legacy visual aliases are still accepted on mobile and route through the unified `analyze_plant_snapshot` path during the transition.
- The server keeps separate turn and snapshot state, dedupes capture/reframe events, and preserves `analysisGoal` through reframe.
- `POST /api/analyze-image` is part of the visual flow: upload -> `analysis.requested` -> `vision.analyze.command` -> `analysis.completed` / `analysis.failed`.
- `POST /api/events` validates canonical envelopes and fans out session events to Redis streams and WebSocket clients.
- `GET /api/realtime-token` requires `x-gardenai-realtime-token-secret` only when `REALTIME_TOKEN_AUTH_SECRET` is set.
- Server tests are green (`40/40`). Mobile still has no automated test harness, so visual flow verification remains manual.
- Required server env vars: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_REALTIME_DEPLOYMENT`, `AZURE_OPENAI_VISION_DEPLOYMENT`, `REDIS_URL`.
- Health and metrics: `GET /healthz`, `GET /metrics`.
