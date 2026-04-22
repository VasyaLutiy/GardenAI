# GardenAI Runbook (MVP)

## Services
- `server/index.js`: API + orchestrator + vision worker + storage cleanup + WS gateway.
- Redis: required for streams, pub/sub, dedupe, and artifact storage.

## Required env (server/.env)
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

## Health
- `GET /healthz` returns `{ status, redisReady, uptimeSec }`.
- `GET /metrics` returns JSON counters.
  - Includes: `requests`, `requestErrors`, `analysisCompleted`, `analysisFailed`, `visionRetries`, `dlqCount`.

## Common failures
- `redis_unavailable`: check Redis URL/password and connectivity.
- `unauthorized`: verify `REALTIME_TOKEN_AUTH_SECRET` and the shared request header on the web/mobile client.
- `azure_not_configured`: missing Azure env vars.
- `analysis_timeout`: check worker health or Azure rate limiting.
- `azure_realtime_secret_failed`: verify realtime deployment name, region support, and endpoint.

## Observability
- Request metrics are in `/metrics` (in-memory counters).
- Optional request logging: set `LOG_REQUESTS=1`.
- Component structured logs are emitted as JSON (default) with fields like
  `component`, `requestId`, `sessionId`, `correlationId`.
- Log controls:
  - `LOG_LEVEL=debug|info|warn|error`
  - `LOG_JSON=1` (default) or `LOG_JSON=0` for plain text
- Rate limiting is enabled on `/api` and WebSocket connections (env: `RATE_LIMIT_*`).
- Realtime token failures are logged with event `azure_realtime_secret_failed`.

## Retention
- Stream data trimmed via `XTRIM MINID` on `RETENTION_HOURS`.
- Image artifacts stored in Redis with TTL.
- Image artifacts are deleted on analysis completion or final failure.

## Smoke tests
```bash
cd server
npm test
npm run smoke:events
npm run smoke:ws
```
