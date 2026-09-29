// K-30b. Тело сообщения MAX для ответа сценария: текст и inline-клавиатура.
// Кнопки с короткой подписью (номера записей перечня) идут рядами до 7, остальные — по одной в ряд, чтобы длинные
// подписи («📋 Мой перечень», «🧪 Показать пример изменения (модельное)») читались и на телефоне.
import type { BotButton, FlowReply } from "../flows/checklist/index.js";

/** Лимиты MAX Bot API (K-05c): кнопок в ряду callback — 7, рядов — 30. */
const MAX_SHORT_PER_ROW = 7;
const MAX_ROWS = 30;
const SHORT_TEXT_LENGTH = 3;

type MaxButton =
  | { readonly type: "callback"; readonly text: string; readonly payload: string }
  | { readonly type: "link"; readonly text: string; readonly url: string }
  | { readonly type: "open_app"; readonly text: string; readonly web_app: string; readonly payload: string };

export interface MaxReplyBody {
  readonly text: string;
  readonly attachments?: readonly {
    readonly type: "inline_keyboard";
    readonly payload: { readonly buttons: readonly (readonly MaxButton[])[] };
  }[];
}

const toMaxButton = (button: BotButton): MaxButton =>
  "webApp" in button
    ? { type: "open_app", text: button.text, web_app: button.webApp, payload: button.payload }
    : "url" in button
      ? { type: "link", text: button.text, url: button.url }
      : { type: "callback", text: button.text, payload: button.payload };

const isShort = (button: MaxButton): boolean =>
  button.type === "callback" && [...button.text].length <= SHORT_TEXT_LENGTH;

/** Раскладка кнопок: подряд идущие короткие — в общий ряд, остальные — по одной. */
export const layoutButtons = (buttons: readonly BotButton[]): MaxButton[][] => {
  const rows: MaxButton[][] = [];
  let shortRow: MaxButton[] = [];
  const flush = () => {
    if (shortRow.length > 0) rows.push(shortRow);
    shortRow = [];
  };
  for (const button of buttons.map(toMaxButton)) {
    if (isShort(button)) {
      if (shortRow.length >= MAX_SHORT_PER_ROW) flush();
      shortRow.push(button);
    } else {
      flush();
      rows.push([button]);
    }
  }
  flush();
  if (rows.length > MAX_ROWS) throw new Error(`Клавиатура ответа содержит больше ${MAX_ROWS} рядов`);
  return rows;
};

export const buildReplyBody = (reply: Pick<FlowReply, "text" | "buttons">): MaxReplyBody =>
  reply.buttons.length === 0
    ? { text: reply.text }
    : {
        text: reply.text,
        attachments: [{ type: "inline_keyboard", payload: { buttons: layoutButtons(reply.buttons) } }],
      };
