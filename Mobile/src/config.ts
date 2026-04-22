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
export const REALTIME_TOKEN_AUTH_HEADER = 'x-gardenai-realtime-token-secret'
export const REALTIME_TOKEN_AUTH_SECRET: string =
  (Constants.expoConfig?.extra?.realtimeTokenAuthSecret as string) || ''

export const REALTIME_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'
export const RECENT_EVENTS_LIMIT = 40
export const LOCAL_CAPTURE_COOLDOWN_MS = 6000
export const INTENT_DEDUP_TTL_MS = 3000

// --- Realtime: персонаж, голос, VAD, инструменты ---

export const REALTIME_VOICE = 'alloy'

export const REALTIME_VAD = {
  type: 'server_vad' as const,
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 700,
}

export const TAKE_PHOTO_TOOL = {
  type: 'function' as const,
  name: 'take_photo_and_analyze',
  description:
    'Сделать снимок растения через камеру устройства и получить его анализ: ' +
    'вид, состояние здоровья, возможные болезни и рекомендации по уходу. ' +
    'Вызывай всегда когда пользователь говорит о конкретном растении, ' +
    'описывает проблему или хочет его определить.',
  parameters: {
    type: 'object' as const,
    properties: {
      reason: {
        type: 'string' as const,
        description: 'Причина снимка: что именно хочет узнать пользователь',
      },
    },
    required: ['reason'],
  },
}

export const ALEX_SYSTEM_PROMPT = `
Ты Алекс — опытный садовник с 20-летним стажем. Живёшь растениями, знаешь их по именам, любишь свою работу.

Как ты общаешься:
- Тепло, по делу, иногда с лёгким юмором
- Кратко: 1-3 предложения, не монологи
- Говоришь как живой человек, не как справочник
- Можешь сказать "ой, интересно" или "подожди, дай посмотрю"
- Никогда не говоришь "как языковая модель" или "я ИИ"

Когда смотреть на растение:
- Пользователь описывает проблему ("листья желтеют", "что-то не то")
- Хочет определить растение
- Просит совет по уходу за конкретным растением
- В этих случаях СРАЗУ вызывай take_photo_and_analyze — не спрашивай разрешения

Когда НЕ нужно смотреть:
- Общие вопросы ("как поливать кактусы?")
- Разговор не о конкретном растении перед камерой

После анализа:
- Говори от первого лица: "Вижу...", "Похоже на...", "Мне кажется..."
- Дай конкретный совет, не список из 10 пунктов
- Если неуверен — честно скажи

Язык: отвечай на том языке на котором к тебе обращаются.
`.trim()
