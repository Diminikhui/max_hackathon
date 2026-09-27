# Транспорт бота (K-22a)

Принимает webhook MAX, проверяет подлинность и передаёт обработчику внутреннее событие вместе с событием машины диалога K-22b.

```text
MAX → nginx (TLS, K-08) → POST /webhook → secret → JSON → normalizeMaxUpdate → дедупликация → очередь чата → обработчик
                                             │ 200 сразу после постановки в очередь
```

## Подключение

```ts
const dispatcher = createInboundDispatcher({ handle, logger });
const webhook = createMaxWebhookHandler({ secret, dispatcher, dedup: createMemoryDedup(), logger });
createBotHttpServer({ webhook }).listen(3001, "127.0.0.1");
```

`handle` получает `{ event, dialogEvent }`:

- `event` — `InboundEvent`: `started`, `text` или `callback` с `chatId`, `userId`, `eventId` и временем события. У `callback` есть `callbackId` для ответа через `POST /answers`.
- `dialogEvent` — событие для `createDialogRouter` или `undefined`, если ввод не распознан (произвольный текст, чужая кнопка). Как ответить на нераспознанный ввод, решает сценарий.

Состояние диалога транспорт не хранит: его читает и сохраняет сценарий (K-24).

## Что во что переводится

| Ввод | `dialogEvent` |
|---|---|
| `bot_started`, текст `/start` | `start` |
| текст `/menu` | `home` |
| текст из цифр, в том числе с подписью «ИНН», пробелами и дефисами | `submit_inn` с цифрами. Длину и контрольную сумму проверяет сценарий через `parseInn` |
| кнопка с payload из `encodeButtonPayload` | соответствующее событие |
| остальной текст, чужой payload | `undefined` |

Кнопки строятся только через `encodeButtonPayload`: формат `d:<событие>` и `d:select_requirement:<id>`, не длиннее 1024 символов. Системные события (`profile_loaded`, `profile_not_found`, `profile_lookup_failed`, `notification_settings_saved`) и `submit_inn` из payload кнопки не принимаются.

Пропускаются без обработки, с ответом 200: групповые чаты, сообщения ботов, сообщения без текста (стикеры, файлы) и остальные типы update.

## Ответы webhook

| Код | Когда |
|---|---|
| 200 | событие принято, пропущено или это повтор |
| 400 | тело не JSON |
| 403 | нет заголовка `X-Max-Bot-Api-Secret` или он не совпал |
| 405 | метод не POST |
| 413 | тело больше 1 МБ |
| 503 | очередь переполнена (20 событий на чат, 1000 всего): MAX повторит доставку позже |

## Ограничения

- Дедупликация и очередь живут в памяти процесса. После перезапуска повтор уже обработанного события будет обработан ещё раз, а события, принятые до перезапуска, но не обработанные, потеряются.
- Ошибка обработчика пишется в лог (`bot.inbound.handler_failed`), повтора нет: MAX уже получил 200.
- В лог не попадают текст сообщений, `chat_id` и `user_id`.
