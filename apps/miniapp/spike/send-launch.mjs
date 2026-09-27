// Spike K-05b: отправляет в чат сообщение с deep link на мини-приложение.
// Запуск: node --env-file=.env apps/miniapp/spike/send-launch.mjs <chat_id> [start_param]
// Кнопка link с https://max.ru/<бот>?startapp=… открывает мини-приложение, привязанное к боту
// в настройках платформы партнёров (Чаты → Настройки).
import { clientFromEnv } from "../../bot/spike/max-client.mjs";
import { buildDeepLink } from "./init-data.mjs";

const BOT_NAME = "t214_hakaton_max_bot";
const [chatId, startParam = "k05b_check"] = process.argv.slice(2);
if (!chatId) {
  console.error("Укажите chat_id");
  process.exit(2);
}

const link = buildDeepLink(BOT_NAME, startParam);
const client = clientFromEnv();
try {
  await client.sendMessage({
    chatId,
    text: "K-05b: откройте мини-приложение",
    buttons: [[{ type: "link", text: "Открыть мини-приложение", url: link }]],
  });
  console.log("Сообщение с deep link отправлено");
} finally {
  client.close();
}
