# GardenAI Implementation ToDo (4 Phases)

## Phase 1 — Foundation: Backend Skeleton and Contracts
Goal: подготовить базовый backend-каркас, контракты и инфраструктурные заготовки.

- [x] Создать структуру backend модулей: `api`, `orchestrator`, `workers/vision`, `workers/storage`.
- [x] Добавить общую конфигурацию через env: `PORT`, `MAX_UPLOAD_BYTES`, `RETENTION_HOURS`, Redis URL.
- [x] Добавить конфигурацию Azure через env: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, deployment names.
- [x] Реализовать `GET /api/realtime-token` с серверным вызовом Azure OpenAI `/openai/v1/realtime/client_secrets`.
- [x] Реализовать `POST /api/events` с приёмом canonical event envelope.
- [x] Подключить Redis (Pub/Sub + Streams) и создать топики/каналы по плану.
- [x] Ввести базовую idempotency проверку по `messageId` (TTL 24h).
- [x] Добавить централизованный формат ошибок API: `{ error, code, requestId }`.

Definition of Done:
- Эндпойнты доступны и проходят smoke-тесты.
- События пишутся в Redis Streams в ожидаемом формате.
- Секреты не утекют в логи/ответы.

## Phase 2 — Core Flow: Image Analysis Orchestration
Goal: собрать рабочий поток анализа изображения через orchestrator и vision worker.

- [x] Реализовать `POST /api/analyze-image` (валидация MIME/size, загрузка изображения).
- [x] Публиковать `analysis.requested` в `stream:session-events`.
- [x] Реализовать `orchestrator-service` (consumer group, state machine, retry policy).
- [x] Реализовать `vision.analyze.command` и обработку в `vision-worker`.
- [x] Интегрировать Azure OpenAI Vision и нормализацию ответа в `analysis.completed`.
- [x] Добавить ветку ошибок: `analysis.failed` + отправка в DLQ после 3 попыток.
- [x] Реализовать storage worker для TTL 24h и периодической очистки.

Definition of Done:
- Запрос с изображением даёт валидный `analysis.completed` либо контролируемый `analysis.failed`.
- Retry/backoff работает по политике `300ms, 1s, 2.5s`.
- Просроченные артефакты очищаются.

## Phase 3 — Realtime and Client Delivery
Goal: подключить realtime аудио и надёжную доставку событий в браузер.

- [x] Реализовать WebSocket gateway (`/ws?sessionId=...`) с session-room маршрутизацией.
- [x] Публиковать статусные события в `chan:session:{sessionId}` и транслировать в WS.
- [x] На клиенте реализовать connect/disconnect WS, обработку `analysis.progress/completed/failed`.
- [x] Реализовать WebRTC flow direct-to-OpenAI с токеном из `/api/realtime-token`.
- [x] Подключить remote audio playback и базовый reconnect (fast-retry + renegotiation).
- [x] Добавить correlationId/causationId связку между событиями клиента и backend workflow.

Definition of Done:
- Клиент получает живые статусы анализа через WS.
- Аудио realtime работает end-to-end через WebRTC.
- При кратковременном обрыве восстановление проходит без потери критичного статуса.

## Phase 4 — Hardening, QA, and Release Readiness
Goal: довести систему до стабильного MVP-качества.

- [x] Добавить unit/integration тесты для API, orchestrator и vision worker.
- [x] Прогнать e2e сценарии: voice + capture + analysis + push result.
- [x] Ввести метрики и логи: latency, error rate, retry count, DLQ depth.
- [x] Ограничить CORS и добавить rate-limits на публичные API.
- [x] Проверить privacy: retention 24h, отсутствие лишнего хранения сырых данных.
- [x] Подготовить runbook: запуск, env, recovery после падений, DLQ replay.
- [x] Финальный чек контрактов (`Plan.md` ↔ реальная реализация).

Definition of Done:
- Все acceptance-сценарии из `Plan.md` проходят.
- Есть наблюдаемость по ключевым SLI.
- MVP готов к ограниченному прод-использованию.
