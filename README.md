# GardenAI — Gardener AI Agent (Web Starter)

This repository contains a minimal starter scaffold for a web-based Gardener AI Agent.

Overview:
- `client/` — React + Vite single-page app. Accesses camera and microphone, captures photos, and has placeholders for OpenAI realtime audio integration.
- `server/` — Minimal Express server with endpoints:
  - `GET /api/realtime-token` — mints an Azure OpenAI realtime client secret.
  - `POST /api/analyze-image` — accepts an image upload and sends it to Azure OpenAI vision model.

Quick start (run client and server separately):

Server

```bash
cd server
npm install
cp .env.example .env
# edit .env and set Azure OpenAI endpoint/key/deployments
npm start
```

Run backend tests

```bash
cd server
npm test
npm run smoke:events
npm run smoke:ws
```

Client

```bash
cd client
npm install
npm run dev
```

Notes:
- Backend uses Azure OpenAI and reads secrets from `server/.env`.
- Required server env vars:
  - `AZURE_OPENAI_ENDPOINT` (example: `https://<resource>.openai.azure.com`)
  - `AZURE_OPENAI_API_KEY`
  - `AZURE_OPENAI_REALTIME_DEPLOYMENT` (Azure deployment name for realtime model)
  - `AZURE_OPENAI_VISION_DEPLOYMENT` (Azure deployment name for vision-capable model)
  - `REDIS_URL` (example: `redis://localhost:6379`)
  - `REALTIME_TOKEN_AUTH_SECRET` (optional shared secret required by `/api/realtime-token` when set)
- `GET /api/realtime-token` calls Azure endpoint `/openai/v1/realtime/client_secrets`.
- WebRTC clients should POST SDP to `/openai/v1/realtime/calls` using the returned `token`.
- `POST /api/analyze-image` calls Azure Chat Completions API using the vision deployment.
- `POST /api/events` validates canonical event envelopes and atomically dedupes, enqueues to Redis stream `stream:session-events`, and fans out to `chan:session:<sessionId>`.
- `GET /api/realtime-token` requires `x-gardenai-realtime-token-secret` only when `REALTIME_TOKEN_AUTH_SECRET` is configured.
- `POST /api/analyze-image` now follows event flow: `analysis.requested` -> `vision.analyze.command` -> `analysis.completed/failed`.
- Realtime transcript events can emit `intent.detected`; orchestrator can publish `capture.requested` and `assistant.prompt`.
- Retry policy for vision worker: 3 attempts with backoff (`300ms`, `1s`, `2.5s`), then message goes to `stream:dlq`.
- Storage worker performs stream TTL cleanup using `XTRIM MINID` based on `RETENTION_HOURS`.
- WebSocket gateway is available at `/ws?sessionId=<id>` and fans out Redis `chan:session:<id>` events to subscribed clients.
- API errors are normalized as `{ error, code, requestId, details }`.
- Health and metrics: `GET /healthz`, `GET /metrics`.
- Rate limiting is enabled on `/api` and WebSocket connections (configurable in `.env`).
- Optional CORS restriction with `CORS_ORIGIN` (comma-separated origins).
- For verbose request logging and realtime token failures, set `LOG_REQUESTS=1` and inspect server stdout.
- Component logging controls:
  - `LOG_LEVEL=debug|info|warn|error`
  - `LOG_JSON=1` (default structured logs) or `LOG_JSON=0` (plain text)

Next steps I can take for you:
- Add websocket auth (signed session token).
- Split in-process orchestrator/workers into separate processes and deployment units.
