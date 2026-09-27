# K-05b: запуск мини-приложения из бота, MAX Bridge, проверка `initData`, deep links

- Дата: 2026-09-27
- Статус: проверка подписи реализована, покрыта модельными тестами и сверена с документацией; живой запуск из бота в MAX **ещё не проверен** (VPS с HTTPS готов в K-08; нужна привязка URL в платформе партнёров — шаги ниже)
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
- Кнопка `open_app` в документации описана без полей. **Проверено на живом боте 27.09.2026** (`POST /messages`, хакатонный контур): поле `web_app` — имя бота или приложения MAX (`t214_hakaton_max_bot`), а не URL; API сам дополняет кнопку полем `contact_id` (ID бота). URL в `web_app` отклоняется: `404 not.found … Link not found with pk = <URL>`. Значит, `open_app` открывает мини-приложение, **привязанное к боту в платформе партнёров**, и без привязки страницу не открывает. Рабочий формат:

  ```json
  { "type": "open_app", "text": "Открыть мини-приложение", "web_app": "t214_hakaton_max_bot" }
  ```

## Как проверить вживую (осталось)

Сверено с документацией 27.09.2026: алгоритм [проверки `initData`](https://dev.max.ru/docs/webapps/validation) совпадает с реализованным; в описании [клавиатуры](https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard) у кнопки `open_app` по-прежнему нет перечня полей, поэтому остаётся кнопка `link` с deep link.

Шаги 1–2 выполнены 27.09.2026: спайк запущен службой `k05b-spike` (соединения только с localhost), Nginx проксирует `https://135.106.227.207/k05b/`.

**Блокер:** бот выдан организаторами, у команды нет доступа к платформе партнёров, а через Bot API URL мини-приложения не задаётся (`GET /me` не содержит таких полей). Шаг 3 выполняют организаторы по запросу команды. Остальные шаги — владелец сервера (@Diminikhui). Спайк временно публикуется под префиксом `/k05b/`; страница обращается к API по относительному пути, поэтому код менять не нужно.

1. **Запустить спайк на VPS** (токен уже лежит в `/etc/max-hackathon/bot.env`, в репозиторий и вывод не попадает):

   ```bash
   cd /srv/max-hackathon/repo && git fetch origin diminikhui/claude/research-k-05b-next-stream
   git worktree add /opt/max-k05b FETCH_HEAD
   sudo systemd-run --unit=k05b-spike --property=EnvironmentFile=/etc/max-hackathon/bot.env \
     node /opt/max-k05b/apps/miniapp/spike/server.mjs 8787
   ```

2. **Временно проксировать** в `server { listen 443 … }` файла `/etc/nginx/sites-enabled/` (не коммитить в `deploy/`):

   ```nginx
   location /k05b/ {
       proxy_pass http://127.0.0.1:8787/;
       proxy_set_header Host $host;
   }
   ```

   Затем `sudo nginx -t && sudo systemctl reload nginx` и проверка `curl -fsS https://135.106.227.207/k05b/ | head -3`.
3. **Платформа партнёров MAX**: Чаты → бот → Настройки → URL мини-приложения `https://135.106.227.207/k05b/` → сохранить.
4. **Открыть из бота**: в MAX нажать кнопку мини-приложения у бота; ожидается «Подпись initData верна».
5. **Deep link**: `sudo systemd-run --pipe --wait --property=EnvironmentFile=/etc/max-hackathon/bot.env node /opt/max-k05b/apps/miniapp/spike/send-launch.mjs <chat_id> k05b_check` (токен читается из файла окружения и не попадает в аргументы процесса) → нажать кнопку в сообщении; ожидается `start_param: k05b_check`.
6. Повторить шаги 4–5 на web, desktop, Android и iOS; записать в Issue #69 только `platform`, `version` и результат (без идентификаторов и данных пользователя).
7. **Убрать временный контур**: `sudo systemctl stop k05b-spike`, удалить `location /k05b/`, `sudo nginx -t && sudo systemctl reload nginx`, `git -C /srv/max-hackathon/repo worktree remove /opt/max-k05b`. URL в платформе партнёров заменить на адрес мини-приложения, когда оно появится (2-01a).

Критерий приёмки «тестовое мини-приложение открывается из бота» считается выполненным только после шагов 1–5.

## Запуск тестов

```bash
node --test apps/miniapp/spike/init-data.test.mjs
```

## Ограничения и риски

- Алгоритм проверен на модельных данных, а не на `initData` от MAX; расхождение в деталях (например, кодирование `+`) выявит только живая проверка.
- Привязка URL к боту делается вручную в платформе партнёров — нужен доступ организатора или владельца бота.
- Полный формат `open_app` не описан в документации.
