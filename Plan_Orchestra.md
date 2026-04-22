# Plan_Orchestra

  ## Summary

  Visual orchestration is implemented across mobile and server.

  - Mobile owns camera capture, the local snapshot buffer, and the realtime visual tools.
  - Mobile visual events use `schemaVersion: 2.0`.
  - Legacy visual aliases are still accepted on mobile and route through the unified `analyze_plant_snapshot` path as transitional compatibility.
  - Server persists separate turn and snapshot state in Redis and dedupes capture/reframe events.
  - `reframe.requested` preserves `analysisGoal` and carries it into downstream `analysis.requested`.
  - Server tests are green (`40/40`).
  - Mobile still has no automated test harness, so manual visual verification is still required.

  Redis is the control plane for orchestration state and events. Binary frames are not stored in Redis.

  ## Public Interfaces

  ### Realtime Tools

  The mobile app exposes 4 visual tools via `Mobile/src/config.ts` and `session.update`.

  #### 1. request_plant_snapshot

  {
    "type": "function",
    "name": "request_plant_snapshot",
    "description": "Запросить захват актуального кадра растения с камеры устройства. Используется перед визуальным анализом или когда нужен новый ракурс.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "reason": {
          "type": "string",
          "description": "Зачем нужен кадр: определение вида, диагностика, проверка листьев и т.д."
        },
        "capture_mode": {
          "type": "string",
          "enum": ["latest_buffered", "fresh_photo"],
          "description": "Использовать последний свежий кадр из буфера или сделать новый снимок."
        },
        "framing_hint": {
          "type": "string",
          "enum": ["whole_plant", "leaf_closeup", "stem_closeup", "soil", "problem_area"],
          "description": "Какой ракурс нужен."
        }
      },
      "required": ["reason"]
    }
  }

  Успешный output:

  {
    "status": "accepted",
    "snapshotId": "snap-uuid",
    "correlationId": "corr-uuid",
    "captureMode": "latest_buffered",
    "framingHint": "leaf_closeup",
    "freshnessMs": 420
  }

  Неуспех:

  {
    "status": "rejected",
    "reasonCode": "camera_busy"
  }

  #### 2. analyze_plant_snapshot

  {
    "type": "function",
    "name": "analyze_plant_snapshot",
    "description": "Запустить анализ уже захваченного snapshot растения.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "snapshotId": {
          "type": "string"
        },
        "analysis_goal": {
          "type": "string",
          "enum": ["identify", "diagnose", "care_advice"]
        }
      },
      "required": ["snapshotId", "analysis_goal"]
    }
  }

  Успешный output:

  {
    "status": "completed",
    "snapshotId": "snap-uuid",
    "analysis": {
      "species": "Monstera deliciosa",
      "confidence": 0.91,
      "diagnoses": ["mild underwatering"],
      "suggestions": ["increase watering frequency"],
      "urgency": "low",
      "disclaimer": "AI-generated guidance."
    }
  }

  #### 3. get_visual_context

  {
    "type": "function",
    "name": "get_visual_context",
    "description": "Получить текущее состояние visual session: есть ли свежий snapshot, идёт ли capture/analyze, есть ли ошибка.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    }
  }

  Output:

  {
    "cameraReady": true,
    "captureState": "idle",
    "analysisState": "idle",
    "activeSnapshotId": "snap-uuid",
    "snapshotAgeMs": 1800,
    "lastAnalysisStatus": "completed"
  }

  #### 4. request_reframe

  {
    "type": "function",
    "name": "request_reframe",
    "description": "Запросить новый кадр с другим ракурсом, если предыдущего snapshot недостаточно.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "snapshotId": {
          "type": "string"
        },
        "framing_hint": {
          "type": "string",
          "enum": ["whole_plant", "leaf_closeup", "stem_closeup", "soil", "problem_area"]
        },
        "reason": {
          "type": "string"
        }
      },
      "required": ["framing_hint", "reason"]
    }
  }

  ### Event Envelope Extensions

  Расширить общий event contract. Для visual events сделать обязательными:

  {
    "messageId": "evt-uuid",
    "type": "capture.requested",
    "sessionId": "session-uuid",
    "correlationId": "corr-uuid",
    "causationId": "toolcall-uuid",
    "tsWallIso": "2026-04-22T12:00:00.000Z",
    "schemaVersion": "2.0",
    "payload": {},
    "snapshotId": "snap-uuid",
    "turnId": "turn-uuid"
  }

  `snapshotId` and `turnId` are carried at the top level for queryability and logging.

  ## Redis Event Types

  ### New Session Events

  Добавить в stream:session-events:

  - capture.requested
    payload: reason, captureMode, framingHint, deadlineMs, requestedBy
  - capture.accepted
    payload: captureMode, cameraState
  - capture.rejected
    payload: reasonCode
  - snapshot.available
    payload: snapshotId, source, captureTs, freshnessMs, framingHint, localAssetRef
  - snapshot.upload.requested
    payload: snapshotId, uploadStrategy
  - snapshot.uploaded
    payload: snapshotId, artifactKey, mimeType, width, height, captureTs
  - analysis.requested
    payload: snapshotId, artifactKey, replyKey, analysisGoal, attempt
  - analysis.completed
    payload: existing analysis JSON + snapshotId
  - analysis.failed
    payload: snapshotId, error, retryable
  - reframe.requested
    payload: targetSnapshotId, framingHint, reason
  - assistant.visual_guidance
    payload: text, reasonCode

  ### Redis Keys

  Current keys:

  - `state:turn:<sessionId>`: active turn JSON
  - `state:snapshot:<snapshotId>`: snapshot state JSON
  - `state:session-visual:<sessionId>`: current camera/analyze state
  - `dedupe:capture:<sessionId>:<correlationId>`
  - `dedupe:analysis-requested:<sessionId>:<snapshotId>:<analysisGoal>`
  - `reply:tool:<callId>` for tool result routing

  TTLs:

  - turn/snapshot state: 10-30 minutes
  - reply keys: 2 minutes
  - image artifacts: keep the existing TTL

  ## Orchestrator State Machine

  ### Primary Entities

  - turn
    Поля: turnId, sessionId, correlationId, source, toolCallId, status
  - snapshot
    Поля: snapshotId, sessionId, turnId, correlationId, status, framingHint, artifactKey
  - analysis job
    Поля: snapshotId, analysisGoal, attempt, status

  ### Turn States

  idle -> awaiting_capture -> snapshot_ready -> analyzing -> completed | failed | cancelled

  Переходы:

  - idle -> awaiting_capture
    когда пришёл request_plant_snapshot или high-confidence visual intent
  - awaiting_capture -> snapshot_ready
    на snapshot.available
  - snapshot_ready -> analyzing
    на analyze_plant_snapshot или auto-policy
  - analyzing -> completed
    на analysis.completed
  - analyzing -> failed
    на analysis.failed
  - awaiting_capture -> failed
    на capture.rejected или timeout
  - any -> cancelled
    если turn superseded новым visual turn

  ### Snapshot States

  requested -> accepted -> captured -> uploaded -> analyzing -> completed | failed | expired

  Переходы:

  - requested
    после capture.requested
  - accepted
    после capture.accepted
  - captured
    после snapshot.available
  - uploaded
    после snapshot.uploaded
  - analyzing
    после analysis.requested
  - completed
    после analysis.completed
  - failed
    после capture.rejected или analysis.failed
  - expired
    по TTL или вытеснению новым snapshot

  ### Orchestrator Policy

  - One active visual turn per session.
  - `request_plant_snapshot` during `awaiting_capture` or `analyzing` reuses the existing valid snapshot instead of creating a second capture.
  - `analyze_plant_snapshot` without a valid `snapshotId` returns a structured error.
  - Auto-analyze is enabled for `identify` and `diagnose`; `care_advice` still prefers a fresh snapshot first.
  - `request_reframe` creates a new `snapshotId` while preserving the same `turnId` and `correlationId`.

  ## Implementation Notes

  ### server/index.js

  Сделать точечный рефактор без выноса в новые модули на первом шаге.

  1. Добавить router для tool lifecycle state:

  - helper loadVisualState(sessionId)
  - helper saveVisualState(sessionId, state)
  - helper saveSnapshotState(snapshotId, state)
  - helper buildToolResult(callId, payload)

  2. Расширить processOrchestratorMessage:

  - обрабатывать новые события capture.accepted, capture.rejected, snapshot.available, snapshot.uploaded, reframe.requested
  - на snapshot.uploaded публиковать analysis.requested в существующем формате
  - на analysis.completed|failed обновлять turn/snapshot state и публиковать финальный tool result event

  3. Изменить /api/analyze-image:

  - не считать endpoint самостоятельным началом orchestration
  - принимать дополнительные поля snapshotId, turnId, analysisGoal, toolCallId
  - при upload писать snapshot.uploaded, а не только голый analysis.requested
  - для backward compatibility, если snapshotId не передан, создавать legacy snapshot автоматически

  4. Усилить event validation:

  - для visual event types требовать correlationId, causationId, snapshotId/turnId
  - отклонять malformed transitions

  5. Оставить processVisionCommand почти без изменений:

  - добавить snapshotId в payload результата
  - reply key использовать для tool-routing и HTTP-legacy response

  ### Mobile

  #### Mobile/src/config.ts

  - убрать TAKE_PHOTO_TOOL
  - добавить массив VISUAL_TOOLS
  - переписать system prompt: модель должна сначала запрашивать snapshot, потом анализировать его; reframe использовать при плохом качестве

  #### Mobile/src/hooks/useRealtime.ts

  - tool dispatcher должен поддерживать несколько tool names
  - хранить map callId -> correlationId/turnId/snapshotId
  - добавить helper для structured function_call_output
  - не создавать synthetic fake function call для server-pushed analysis; вместо этого возвращать результат в тот call, который реально ждёт output
  - если server event приходит без ожидающего call, использовать conversation.item.create с системным event summary, а не поддельный function call

  #### Mobile/src/screens/MainScreen.tsx

  - выделить visual orchestrator state:
    activeTurn, activeSnapshot, captureState, analysisState
  - handleToolCall разделить:
      - request_plant_snapshot
      - analyze_plant_snapshot
      - get_visual_context
      - request_reframe
  - на request_plant_snapshot:
      - создать turnId/snapshotId/correlationId
      - отправить capture.accepted
      - взять кадр из буфера или сделать новый
      - отправить snapshot.available
      - вызвать upload с snapshotId
  - добавить локальный ring buffer snapshots:
      - пока без video stream, достаточно хранить 1-3 последних still captures/preview-derived frames
      - policy: использовать буферный кадр только если freshnessMs <= 1500 и камера ready
  - обновить WS handler:
      - принимать assistant.visual_guidance, analysis.completed, analysis.failed
      - матчить только события активного turn
  - legacy path:
      - ручная кнопка "Снять и отправить" должна использовать тот же snapshot flow, но без realtime tool call

  ## Tests

  ### Server

  - event-envelope
      - visual events без correlationId отклоняются
      - invalid transition отклоняется
  - event-ingest
      - snapshot.uploaded публикуется и дедупится корректно
  - processOrchestratorMessage
      - capture.requested -> capture.accepted -> snapshot.available -> snapshot.uploaded -> analysis.requested
      - capture.rejected переводит turn в failed
      - повторный request_plant_snapshot при active turn не создаёт новый snapshot
  - vision-worker
      - analysis.completed сохраняет snapshotId
      - retry path не теряет turnId/correlationId/snapshotId

  ### Mobile

  - tool call request_plant_snapshot создаёт snapshot state и возвращает structured output
  - analyze_plant_snapshot без snapshot возвращает error
  - request_reframe создаёт новый snapshot с тем же turnId
  - server-pushed analysis.completed доставляется только в активный call
  - гонка tool_call + intent fallback не создаёт второй capture
  - automated mobile harness is still missing; coverage is manual for now

  ### End-to-End

  - voice intent identify -> snapshot request -> upload -> analysis complete -> spoken response
  - bad image -> request_reframe -> second snapshot -> successful analysis
  - camera busy -> capture.rejected -> assistant asks user to hold device steady / retry later

  ## Assumptions And Defaults

  - `server/index.js` still hosts the current integration point.
  - Redis is used only for control/state/events; images are not streamed through Redis.
  - The live flow uses a recent buffered still when available, not continuous video inference.
  - Backward compatibility with the current `/api/analyze-image` path is preserved.
  - One session supports one active visual turn.
  - Auto-analyze is enabled after `snapshot.available` for `identify` and `diagnose`; other goals still require an explicit `analyze_plant_snapshot` call.
