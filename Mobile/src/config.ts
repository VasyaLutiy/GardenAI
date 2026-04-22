import Constants from 'expo-constants'

export const API_BASE: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string) || 'http://10.0.2.2:3000'
export const REALTIME_TOKEN_AUTH_HEADER = 'x-gardenai-realtime-token-secret'
export const REALTIME_TOKEN_AUTH_SECRET: string =
  (Constants.expoConfig?.extra?.realtimeTokenAuthSecret as string) || ''

// Android эмулятор: 10.0.2.2 → localhost хоста
// iOS симулятор:    localhost работает напрямую
// Физическое устройство: укажи IP машины, например http://192.168.1.x:3000

export const WS_BASE: string = API_BASE.replace(/^http/i, 'ws')

export const REALTIME_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'
export const RECENT_EVENTS_LIMIT = 40
export const LOCAL_CAPTURE_COOLDOWN_MS = 6000
export const INTENT_DEDUP_TTL_MS = 3000
export const SNAPSHOT_BUFFER_LIMIT = 3
export const SNAPSHOT_BUFFER_FRESHNESS_MS = 1500
export const TOOL_RESULT_TTL_MS = 120000

// --- Realtime: персонаж, голос, VAD, инструменты ---

export const REALTIME_VOICE = 'alloy'

export const REALTIME_VAD = {
  type: 'server_vad' as const,
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 700,
}

export const REQUEST_PLANT_SNAPSHOT_TOOL = {
  type: 'function' as const,
  name: 'request_plant_snapshot',
  description:
    'Запросить захват актуального кадра растения с камеры устройства.',
  parameters: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      reason: {
        type: 'string' as const,
        description: 'Зачем нужен кадр',
      },
      capture_mode: {
        type: 'string' as const,
        enum: ['latest_buffered', 'fresh_photo'],
      },
      framing_hint: {
        type: 'string' as const,
        enum: ['whole_plant', 'leaf_closeup', 'stem_closeup', 'soil', 'problem_area'],
      },
    },
    required: ['reason'],
  },
}

export const ANALYZE_PLANT_SNAPSHOT_TOOL = {
  type: 'function' as const,
  name: 'analyze_plant_snapshot',
  description: 'Запустить анализ уже захваченного snapshot растения.',
  parameters: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      snapshotId: { type: 'string' as const },
      analysis_goal: {
        type: 'string' as const,
        enum: ['identify', 'diagnose', 'care_advice'],
      },
    },
    required: ['snapshotId', 'analysis_goal'],
  },
}

export const GET_VISUAL_CONTEXT_TOOL = {
  type: 'function' as const,
  name: 'get_visual_context',
  description: 'Получить текущее состояние visual session.',
  parameters: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {},
  },
}

export const REQUEST_REFRAME_TOOL = {
  type: 'function' as const,
  name: 'request_reframe',
  description: 'Запросить новый кадр с другим ракурсом.',
  parameters: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      snapshotId: { type: 'string' as const },
      framing_hint: {
        type: 'string' as const,
        enum: ['whole_plant', 'leaf_closeup', 'stem_closeup', 'soil', 'problem_area'],
      },
      reason: { type: 'string' as const },
    },
    required: ['framing_hint', 'reason'],
  },
}

export const VISUAL_TOOLS = [
  REQUEST_PLANT_SNAPSHOT_TOOL,
  ANALYZE_PLANT_SNAPSHOT_TOOL,
  GET_VISUAL_CONTEXT_TOOL,
  REQUEST_REFRAME_TOOL,
] as const

export const ALEX_SYSTEM_PROMPT = `
Ты Алекс — опытный садовник с практическим взглядом. Отвечай тепло, кратко и по делу, обычно 1-3 предложениями.

Правила visual tools:
- Если нужно посмотреть на конкретное растение, сначала вызывай request_plant_snapshot.
- После успешного snapshot используй analyze_plant_snapshot со snapshotId.
- Если кадр неудачный или ракурс слабый, вызывай request_reframe.
- Перед повторным захватом или анализом можешь вызвать get_visual_context.
- Никогда не придумывай snapshotId, turnId или результат анализа.
- Не говори, что анализ завершен, пока tool output не вернет status=completed.
- Если tool вернул rejected или failed, коротко объясни пользователю что сделать дальше.

Когда смотреть на растение:
- Пользователь хочет определить растение.
- Пользователь описывает проблему конкретного растения.
- Пользователь просит совет по уходу за растением, которое видно в камере.

Когда не нужен visual tool:
- Общие вопросы без конкретного растения перед камерой.
- Разговоры о садоводстве без необходимости смотреть изображение.

После анализа:
- Говори от первого лица: "Вижу...", "Похоже на...", "Я бы сделал так..."
- Если уверенность низкая, честно скажи это и предложи новый ракурс.

Язык ответа: тот же, что использует пользователь.
`.trim()
