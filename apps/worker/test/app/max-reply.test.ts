// K-30b: порт ответов MAX на модельном транспорте: какие запросы уходят и что делается при отказе MAX.
import type { FlowReply } from "@max-hackathon/bot/dist/flows/checklist/index.js";
import { describe, expect, it } from "vitest";
import { createMaxReplyPort, messageIdFrom } from "../../src/app/max-reply.js";
import type { MaxApiRequest, MaxApiTransport } from "../../src/sender/queue/index.js";

const reply: FlowReply = {
  text: "Главное меню",
  sourceUrls: [],
  automated: true,
  buttons: [{ text: "📋 Мой перечень", payload: "d:open_requirements" }],
};

const setup = (responses: Response[]) => {
  const calls: { operation: string; request: MaxApiRequest }[] = [];
  const next = () => responses.shift() ?? new Response("{}", { status: 200 });
  const transport = {
    request: async () => next(),
    upload: async () => next(),
    send: async (request: MaxApiRequest) => {
      calls.push({ operation: "send", request });
      return next();
    },
    service: async (request: MaxApiRequest) => {
      calls.push({ operation: "service", request });
      return next();
    },
  } as MaxApiTransport;
  const warnings: string[] = [];
  const port = createMaxReplyPort(transport, { warn: (event) => warnings.push(event) });
  return { port, calls, warnings };
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("идентификатор сообщения из ответа MAX", () => {
  it("берёт message.body.mid и отвергает всё остальное", () => {
    expect(messageIdFrom({ message: { body: { mid: "mid.1" } } })).toBe("mid.1");
    for (const bad of [
      undefined,
      null,
      {},
      { message: {} },
      { message: { body: {} } },
      { message: { body: { mid: 5 } } },
    ]) {
      expect(messageIdFrom(bad)).toBeUndefined();
    }
  });
});

describe("порт ответов MAX", () => {
  it("send: POST /messages с клавиатурой, возвращает идентификатор и текст", async () => {
    const { port, calls } = setup([json({ message: { body: { mid: "mid.42" } } })]);

    const sent = await port.send("100500", reply);

    expect(sent).toEqual({ messageId: "mid.42", text: "Главное меню" });
    expect(calls[0]?.request.path).toBe("messages?chat_id=100500");
    expect(calls[0]?.request.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.request.init?.body));
    expect(body.text).toBe("Главное меню");
    expect(body.attachments[0].type).toBe("inline_keyboard");
  });

  it("send: отказ MAX не бросает исключение и не даёт идентификатор", async () => {
    const { port, warnings } = setup([json({ code: "x" }, 400)]);
    expect(await port.send("100500", reply)).toBeUndefined();
    expect(warnings).toEqual(["bot.reply.send_failed"]);
  });

  it("clearKeyboard: PUT /messages с пустыми вложениями и прежним текстом", async () => {
    const { port, calls } = setup([json({ success: true })]);

    await port.clearKeyboard?.("100500", { messageId: "mid.42", text: "Главное меню" });

    expect(calls[0]?.operation).toBe("service");
    expect(calls[0]?.request.path).toBe("messages?message_id=mid.42");
    expect(calls[0]?.request.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.request.init?.body))).toEqual({ text: "Главное меню", attachments: [] });
  });

  it("clearKeyboard и acknowledge: отказ MAX только пишется в лог", async () => {
    const { port, warnings } = setup([json({}, 403), json({}, 400)]);
    await port.clearKeyboard?.("100500", { messageId: "mid.1", text: "t" });
    await port.acknowledge?.("cb-1");
    expect(warnings).toEqual(["bot.reply.clear_keyboard_rejected", "bot.reply.acknowledge_rejected"]);
  });

  it("acknowledge: POST /answers по callback_id", async () => {
    const { port, calls } = setup([json({ success: true })]);
    await port.acknowledge?.("cb 1");
    expect(calls[0]?.request.path).toBe("answers?callback_id=cb%201");
    expect(calls[0]?.request.init?.method).toBe("POST");
  });
});
