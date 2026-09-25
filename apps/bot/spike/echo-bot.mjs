// Spike K-05a: long polling, ответ на сообщение с кнопками, обработка нажатия.
// Только для разработки: в production MAX требует webhook (docs/research/k05c-max-bot-api-limits.md).
// Запуск: node --env-file=.env apps/bot/spike/echo-bot.mjs  (остановка — Ctrl+C)
import { clientFromEnv } from "./max-client.mjs";

const client = clientFromEnv();
const buttons = [
  [
    { type: "callback", text: "Да", payload: "spike:yes" },
    { type: "callback", text: "Нет", payload: "spike:no" },
  ],
];

let marker;
let running = true;
process.on("SIGINT", () => {
  running = false;
});

while (running) {
  try {
    const { updates = [], marker: next } = await client.getUpdates({
      marker,
      timeout: 30,
      types: ["message_created", "message_callback", "bot_started"],
    });
    marker = next ?? marker;
    for (const update of updates) {
      // В лог — только тип события и идентификатор чата, без текста пользователя.
      const chatId = update.message?.recipient?.chat_id ?? update.chat_id;
      console.log(`update ${update.update_type} chat=${chatId ?? "-"}`);
      if (update.update_type === "message_created" || update.update_type === "bot_started") {
        await client.sendMessage({ chatId, text: "Spike K-05a: бот на связи. Проверим кнопки?", buttons });
      } else if (update.update_type === "message_callback") {
        const choice = update.callback.payload === "spike:yes" ? "Да" : "Нет";
        await client.answerCallback({ callbackId: update.callback.callback_id, notification: `Вы выбрали: ${choice}` });
      }
    }
  } catch (error) {
    console.error(String(error));
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
client.close();
