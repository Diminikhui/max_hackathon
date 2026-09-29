// Модельный MAX для e2e: HTTP-клиент, который подставляется в транспорт процесса вместо `fetch`.
// Запоминает все запросы к Bot API, отдаёт идентификаторы сообщений и хранит, какие сообщения ещё с кнопками.
// Реальный MAX не вызывается; всё, что здесь «приходит в чат», — модельное.

export interface SentMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly text: string;
  readonly buttons: readonly { readonly text: string; readonly payload?: string; readonly url?: string }[];
  /** Кнопки сняты запросом `PUT /messages`. */
  keyboardRemoved: boolean;
  /** Сообщение пришло из очереди уведомлений (push), а не ответом диалога. */
  readonly fromQueue: boolean;
}

export interface FakeMaxOptions {
  /** Статус ответа на `PUT /messages` и `POST /answers`; по умолчанию 200. */
  readonly failEdits?: boolean;
}

interface MaxKeyboardButton {
  readonly text: string;
  readonly payload?: string;
  readonly url?: string;
}

export class FakeMax {
  readonly messages: SentMessage[] = [];
  readonly acknowledged: string[] = [];
  readonly requests: { readonly method: string; readonly path: string }[] = [];
  readonly #failEdits: boolean;

  constructor(options: FakeMaxOptions = {}) {
    this.#failEdits = options.failEdits === true;
  }

  /** Подставляется как `fetch` транспорта. */
  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = `${url.pathname.replace(/^\//, "")}${url.search}`;
    this.requests.push({ method, path });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (url.pathname.endsWith("/messages") && method === "POST") {
      const chatId = url.searchParams.get("chat_id") ?? "";
      const attachments = (body.attachments ?? []) as { payload?: { buttons?: MaxKeyboardButton[][] } }[];
      const buttons = attachments.flatMap((attachment) => attachment.payload?.buttons?.flat() ?? []);
      const message: SentMessage = {
        messageId: `mid.${this.messages.length + 1}`,
        chatId,
        text: String(body.text ?? ""),
        buttons,
        keyboardRemoved: false,
        // Push из очереди начинается с заголовка шаблона K-23 «🔔 Изменение»; ответы диалога — с других строк.
        fromQueue: String(body.text ?? "").startsWith("🔔 Изменение"),
      };
      this.messages.push(message);
      return json({ message: { body: { mid: message.messageId, text: message.text } } });
    }
    if (url.pathname.endsWith("/messages") && method === "PUT") {
      if (this.#failEdits) return json({ code: "forbidden" }, 403);
      const message = this.messages.find((item) => item.messageId === url.searchParams.get("message_id"));
      if (message && Array.isArray(body.attachments) && body.attachments.length === 0) message.keyboardRemoved = true;
      return json({ success: true });
    }
    if (url.pathname.endsWith("/answers") && method === "POST") {
      if (this.#failEdits) return json({ code: "forbidden" }, 403);
      this.acknowledged.push(url.searchParams.get("callback_id") ?? "");
      return json({ success: true });
    }
    return json({ code: "not_found", message: `${method} ${url.pathname}` }, 404);
  };

  /** Сообщения бота в чате, без push из очереди. */
  dialog(chatId: string): SentMessage[] {
    return this.messages.filter((message) => message.chatId === chatId && !message.fromQueue);
  }

  /** Push-уведомления в чате. */
  pushes(chatId: string): SentMessage[] {
    return this.messages.filter((message) => message.chatId === chatId && message.fromQueue);
  }

  last(chatId: string): SentMessage {
    const message = this.dialog(chatId).at(-1);
    if (!message) throw new Error(`В чате ${chatId} нет ответов бота`);
    return message;
  }
}
