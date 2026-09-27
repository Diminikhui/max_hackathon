// Spike K-05b: отдаёт тестовую страницу и проверяет initData на сервере.
// Запуск за HTTPS-прокси (MAX принимает только HTTPS URL):
//   node --env-file=.env apps/miniapp/spike/server.mjs [порт, по умолчанию 8787]
// В лог пишутся только код результата и платформа, без initData и данных пользователя.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { validateInitData, InitDataError } from "./init-data.mjs";

const token = process.env.MAX_BOT_TOKEN;
if (!token) throw new Error("MAX_BOT_TOKEN не задан");
const port = Number(process.argv[2] ?? 8787);
const page = await readFile(new URL("./index.html", import.meta.url));
const MAX_BODY = 16 * 1024;

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

createServer((req, res) => {
  const path = new URL(req.url, "http://local").pathname;
  if (req.method === "GET" && (path === "/" || path === "/index.html")) return send(res, 200, page, "text/html; charset=utf-8");
  if (req.method !== "POST" || path !== "/api/validate") return send(res, 404, { ok: false, code: "not_found" });

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) req.destroy();
  });
  req.on("end", () => {
    try {
      const data = validateInitData(body.trim(), token);
      console.log("validate ok");
      send(res, 200, {
        ok: true,
        user_id: data.user?.id,
        chat_type: data.chat?.type,
        start_param: data.startParam ?? null,
        auth_date: data.authDate,
      });
    } catch (error) {
      const code = error instanceof InitDataError ? error.code : "internal";
      console.log(`validate fail: ${code}`);
      send(res, error instanceof InitDataError ? 401 : 500, { ok: false, code });
    }
  });
}).listen(port, () => console.log(`K-05b spike: http://127.0.0.1:${port}`));
