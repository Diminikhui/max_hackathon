# K-05b: запуск мини-приложения из бота, MAX Bridge, проверка `initData`, deep links

- Дата: 2026-09-27
- Статус: проверка подписи реализована и покрыта модельными тестами; живой запуск из бота в MAX **ещё не проверен** (нужны VPS с HTTPS и привязка URL в платформе партнёров — шаги ниже)
- Код: [`apps/miniapp/spike/`](../../apps/miniapp/spike/)
- Основа: бот и клиент из K-05a ([k05a-max-bot-connection.md](k05a-max-bot-connection.md)), лимиты — [k05c-max-bot-api-limits.md](k05c-max-bot-api-limits.md)

## Что сделано

| Файл | Назначение |
| --- | --- |
| `init-data.mjs` | Проверка подписи и срока `initData`, разбор `user`/`chat`/`start_param`, сборка deep link, проверка `start_param` |
| `init-data.test.mjs` | Модельные тесты (выдуманный токен и пользователь): верная подпись, порядок полей, подмена поля, чужой токен, нет `hash`, повтор параметра, срок, deep link |
| `server.mjs` | Тестовый сервер: отдаёт страницу и проверяет `initData` в `POST /api/validate` |
| `index.html` | Тестовая страница: подключает MAX Bridge, отправляет `WebApp.initData` на сервер, показывает результат |
| `send-launch.mjs` | Отправляет в чат сообщение с кнопкой-ссылкой `https://max.ru/t214_hakaton_max_bot?startapp=…` |

## Проверка `initData`

По [документации](https://dev.max.ru/docs/webapps/validation) (совпадает со схемой Telegram WebApp):

1. `initData` — строка `k=v&…` в URL-кодировке; каждый параметр ровно один раз.
2. Извлечь `hash`, остальные значения URL-декодировать, отсортировать по ключу, склеить `key=value` через `\n`.
3. `secret = HMAC-SHA256(key="WebAppData", data=BOT_TOKEN)`; `hash' = hex(HMAC-SHA256(key=secret, data=строка))`.
4. Сравнить `hash'` и `hash` за постоянное время (`timingSafeEqual`).

Дополнительно проверяется `auth_date` (секунды Unix): по умолчанию не старше 24 часов; значение настраивается (`maxAgeSec`), для сессий приложения стоит сократить. Повтор параметра, пустая строка и отсутствие `hash` отклоняются с кодом ошибки.

Решения:

- **Доверяем только серверной проверке.** `initDataUnsafe` на клиенте используется лишь для отображения; идентификатор пользователя берётся из проверенного `initData`.
- **Токен бота — только на сервере** (`MAX_BOT_TOKEN`, как в K-05a). В лог сервера пишется лишь код результата, без `initData` и данных пользователя.
- **Новых переменных окружения нет**: порт тестового сервера передаётся аргументом.

## MAX Bridge

- Скрипт: `https://st.max.ru/js/max-web-app.js`, объект `window.WebApp` (без отдельной инициализации).
- Поля: `initData`, `initDataUnsafe` (`user`, `chat {id, type}`, `start_param`, `auth_date`, `query_id`), `platform` (`ios | android | desktop | web`), `version`.
- Методы, нужные MVP: `ready()`, `close()`, `openLink(url)`, `openMaxLink(url)`, `requestContact()`, `BackButton.show()/hide()`.
- Источник: [MAX Bridge](https://dev.max.ru/docs/webapps/bridge).

## Deep links

- Формат: `https://max.ru/<botName>?startapp=<payload>` ([введение](https://dev.max.ru/docs/webapps/introduction)).
- `payload`: до 512 символов, только `A-Z a-z 0-9 _ -`; иначе параметр отбрасывается платформой. Приходит в `start_param` и входит в подписанный `initData`, поэтому ему можно доверять после проверки подписи.
- Для MVP: `startapp` несёт только непрозрачный идентификатор (например, `case_<id>`), без ИНН и персональных данных.
- Кнопка `open_app` в клавиатуре документирована без полного набора полей, поэтому spike открывает приложение кнопкой `link` с deep link. Поля `open_app` нужно уточнить на живом боте (K-21b).

## Как проверить вживую (осталось)

1. На VPS из K-05a: `node --env-file=.env apps/miniapp/spike/server.mjs 8787` за HTTPS-прокси (MAX принимает только HTTPS URL, до 1 024 символов).
2. В платформе партнёров MAX: Чаты → Настройки → вставить URL страницы, выбрать тип кнопки, сохранить.
3. Открыть бота в MAX и нажать кнопку мини-приложения; ожидается «Подпись initData верна».
4. `node --env-file=.env apps/miniapp/spike/send-launch.mjs <chat_id> k05b_check` → нажать кнопку в сообщении; ожидается `start_param: k05b_check`.
5. Повторить на Android, iOS, desktop и web; записать `platform` и `version` (без данных пользователя) в Issue #69.

Критерий приёмки «тестовое мини-приложение открывается из бота» считается выполненным только после шагов 1–4.

## Запуск тестов

```bash
node --test apps/miniapp/spike/init-data.test.mjs
```

## Ограничения и риски

- Алгоритм проверен на модельных данных, а не на `initData` от MAX; расхождение в деталях (например, кодирование `+`) выявит только живая проверка.
- Привязка URL к боту делается вручную в платформе партнёров — нужен доступ организатора или владельца бота.
- Полный формат `open_app` не описан в документации.
