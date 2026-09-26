// Temporary K-08 webhook transport for the explicitly labelled K-05a spike.
// K-22a will replace this handler with the product bot.

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { clientFromEnv } = await import(pathToFileURL(resolve(process.cwd(), "apps/bot/spike/max-client.mjs")).href);
const secret = process.env.MAX_WEBHOOK_SECRET;
if (!secret || secret.length < 5) throw new Error("MAX_WEBHOOK_SECRET is required");
const client = clientFromEnv();

const buttons = [
  [
    { type: "callback", text: "Да", payload: "spike:yes" },
    { type: "callback", text: "Нет", payload: "spike:no" },
  ],
];

async function handle(update) {
  const chatId = update.message?.recipient?.chat_id ?? update.chat_id;
  console.log(`MAX update type=${update.update_type ?? "unknown"}`);
  if (update.update_type === "message_created" || update.update_type === "bot_started") {
    if (!chatId) throw new Error("MAX update has no chat ID");
    await client.sendMessage({
      chatId,
      text: "Spike K-05a: бот на связи через webhook VPS. Проверим кнопки?",
      buttons,
    });
  } else if (update.update_type === "message_callback") {
    const callbackId = update.callback?.callback_id;
    if (!callbackId) throw new Error("MAX callback has no ID");
    const choice = update.callback.payload === "spike:yes" ? "Да" : "Нет";
    await client.answerCallback({ callbackId, notification: `Вы выбрали: ${choice}` });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end();
    return;
  }
  const expected = Buffer.from(secret);
  const supplied = Buffer.from(String(req.headers["x-max-bot-api-secret"] ?? ""));
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    res.writeHead(403).end();
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    await handle(update);
    res.writeHead(200).end("ok");
  } catch {
    console.error("MAX webhook processing failed");
    if (!res.headersSent) res.writeHead(503).end();
  }
});

server.listen(3001, "127.0.0.1", () => console.log("MAX webhook listening on 127.0.0.1:3001"));
process.on("SIGTERM", () => server.close(() => client.close()));
