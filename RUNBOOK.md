# GardenAI Runbook

## Services
- `server/index.js`: API, orchestrator, vision worker, storage cleanup, and WS gateway.
- Redis: required for streams, pub/sub, dedupe keys, and turn/snapshot state.

## Required env
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_REALTIME_DEPLOYMENT`
- `AZURE_OPENAI_VISION_DEPLOYMENT`
- `REDIS_URL`
- `REALTIME_TOKEN_AUTH_SECRET` (optional; when set, clients must send `x-gardenai-realtime-token-secret`)

## Start
```bash
cd server
npm install
npm start
```

## How to build Android APK
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
- Use `expo prebuild` only if native Android code or config must be regenerated, because it can rewrite the checked-in native project.
- The release APK build is currently suitable for testing, but device runtime validation is still recommended.

## Health
- `GET /healthz` returns `{ status, redisReady, uptimeSec }`.
- `GET /metrics` returns counters for requests, errors, analysis outcomes, retries, and DLQ depth.

## Visual flow
- Mobile emits `capture.requested` / `reframe.requested` on `schemaVersion: 2.0`.
- Server persists separate `state:turn:*` and `state:snapshot:*` records.
- Capture and reframe requests are deduped by correlation.
- `reframe.requested` preserves `analysisGoal` into downstream `analysis.requested`.

## Common failures
- `redis_unavailable`: check Redis URL, password, and connectivity.
- `unauthorized`: verify `REALTIME_TOKEN_AUTH_SECRET` and the shared request header on the mobile/web client.
- `azure_not_configured`: missing Azure env vars.
- `analysis_timeout`: check worker health, Redis, and Azure rate limiting.
- `capture.rejected` with `camera_busy` or `camera_not_ready`: retry after the camera is free or the device is ready.
- `analysis_failed`: check the returned error payload; repeated failures also emit `assistant.visual_guidance`.

## Observability
- Request metrics are in `/metrics`.
- Optional request logging: set `LOG_REQUESTS=1`.
- Structured logs default to JSON with fields like `component`, `requestId`, `sessionId`, and `correlationId`.
- Log controls:
  - `LOG_LEVEL=debug|info|warn|error`
  - `LOG_JSON=1` (default) or `LOG_JSON=0` for plain text
- Rate limiting is enabled on `/api` and WebSocket connections.
- Realtime token failures are logged with event `azure_realtime_secret_failed`.

## Retention
- Streams are trimmed with `XTRIM MINID` based on `RETENTION_HOURS`.
- Image artifacts live in Redis with TTL and are removed after successful analysis or final failure.
- Turn and snapshot state are TTL-bound; most stale state clears without manual cleanup.

## Smoke tests
```bash
cd server
npm test
npm run smoke:events
npm run smoke:ws
```
