// Модельные update MAX по OpenAPI schema_2026_07_01. Идентификаторы и тексты вымышленные.

export const MODEL_CHAT_ID = 100_000_001;
export const MODEL_USER_ID = 200_000_002;
export const MODEL_TIMESTAMP = 1_790_000_000_000;

export const messageCreated = (
  text: string | null,
  overrides: { mid?: string; chatType?: string; isBot?: boolean } = {},
) => ({
  update_type: "message_created",
  timestamp: MODEL_TIMESTAMP,
  user_locale: "ru",
  message: {
    sender: {
      user_id: MODEL_USER_ID,
      first_name: "Модельный",
      username: null,
      is_bot: overrides.isBot ?? false,
      last_activity_time: MODEL_TIMESTAMP,
      name: "Модельный пользователь",
    },
    recipient: { chat_id: MODEL_CHAT_ID, chat_type: overrides.chatType ?? "dialog", user_id: MODEL_USER_ID },
    timestamp: MODEL_TIMESTAMP,
    body: { mid: overrides.mid ?? "mid.model-1", seq: 1, text, attachments: null },
  },
});

export const messageCallback = (payload: string, callbackId = "cb.model-1") => ({
  update_type: "message_callback",
  timestamp: MODEL_TIMESTAMP,
  callback: {
    timestamp: MODEL_TIMESTAMP,
    callback_id: callbackId,
    payload,
    user: { user_id: MODEL_USER_ID, first_name: "Модельный", username: null, is_bot: false, last_activity_time: 0 },
  },
  message: {
    recipient: { chat_id: MODEL_CHAT_ID, chat_type: "dialog", user_id: MODEL_USER_ID },
    timestamp: MODEL_TIMESTAMP,
    body: { mid: "mid.model-bot", seq: 2, text: "Меню", attachments: null },
  },
});

export const botStarted = (payload?: string) => ({
  update_type: "bot_started",
  timestamp: MODEL_TIMESTAMP,
  chat_id: MODEL_CHAT_ID,
  user: { user_id: MODEL_USER_ID, first_name: "Модельный", username: null, is_bot: false, last_activity_time: 0 },
  ...(payload === undefined ? {} : { payload }),
  user_locale: "ru",
});
