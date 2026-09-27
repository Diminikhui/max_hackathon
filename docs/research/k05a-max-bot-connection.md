# K-05a: подключение бота MAX (`t214_hakaton_max_bot`)

- Дата: 2026-09-25
- Статус: сертификат, TLS, `GET /me`, приём тестового события и отправка ответа с inline-кнопкой проверены на VPS
- Код: [`apps/bot/spike/`](../../apps/bot/spike/)

## Что сделано

| Файл | Назначение |
| --- | --- |
| `max-client.mjs` | Клиент Bot API без зависимостей: `GET /me`, `GET /updates` (long polling), `POST /messages` с inline-кнопками, `POST /answers` |
| `me.mjs` | Проверка критерия приёмки: `GET /me` должен вернуть ник `t214_hakaton_max_bot` |
| `echo-bot.mjs` | Приём событий polling'ом, ответ с двумя кнопками `callback`, ответ на нажатие |
| `max-client.test.mjs` | Тесты на модельном самоподписанном УЦ: отпечаток, запрос через HTTPS с доверием только процессу, обрыв ответа, ошибки API |

Решения:

- **Доверие сертификату только процессу.** Сертификат НУЦ передаётся в `https.Agent` клиента вместе со стандартными корнями Node (`tls.rootCertificates`). Системное хранилище не меняется, `NODE_TLS_REJECT_UNAUTHORIZED` не трогается. Альтернатива для сервиса — `NODE_EXTRA_CA_CERTS=$MAX_CA_CERT_PATH`.
- **Проверка отпечатка перед использованием.** Клиент читает `MAX_CA_CERT_PATH`, считает SHA-256 и сравнивает с `MAX_CA_CERT_SHA256`. Без отпечатка или при несовпадении клиент не запускается. Отпечаток в коде не зашит: его записывает тот, кто скачал сертификат и сверил его по двум официальным источникам.
- **Надёжность приёма.** Обрыв ответа после заголовков завершает запрос ошибкой (long polling не зависает); `marker` сдвигается только после обработки пачки, сбойное событие повторяется до трёх раз.
- **Токен только в заголовке `Authorization`** и никогда не выводится; в лог бота пишутся лишь тип события и `chat_id`.
- **Приём событий — long polling** только для разработки. В production — webhook на 443 (K-08, K-22a); при активной подписке polling не работает. Подробно — [k05c-max-bot-api-limits.md](k05c-max-bot-api-limits.md).

## Пример вызовов

```bash
# .env: MAX_BOT_TOKEN, MAX_API_BASE_URL, MAX_CA_CERT_PATH=certs/russian_trusted_root_ca.crt, MAX_CA_CERT_SHA256=<отпечаток>
node --env-file=.env apps/bot/spike/me.mjs         # ожидается "username": "t214_hakaton_max_bot"
node --env-file=.env apps/bot/spike/echo-bot.mjs   # написать боту в MAX, нажать кнопку
node --test apps/bot/spike/max-client.test.mjs     # модельные тесты
```

То же через curl (проверка сертификата включена, без `-k`):

```bash
set -a; source .env; set +a
curl -s --cacert "$MAX_CA_CERT_PATH" -H "Authorization: $MAX_BOT_TOKEN" "$MAX_API_BASE_URL/me"
curl -s --cacert "$MAX_CA_CERT_PATH" -H "Authorization: $MAX_BOT_TOKEN" -H "Content-Type: application/json" \
  -X POST "$MAX_API_BASE_URL/messages?chat_id=<chat_id>" \
  -d '{"text":"Проверка","attachments":[{"type":"inline_keyboard","payload":{"buttons":[[{"type":"callback","text":"Да","payload":"yes"}]]}}]}'
```

## Что осталось

На компьютере автора устанавливать и скачивать сертификат НУЦ нельзя. Проверка сертификата выполнена только на VPS `135.106.227.207`:

- Публичный PEM-сертификат скачан с [сервера Госуслуг](https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer) и независимо с [сервера Ростелекома](https://company.rt.ru/cdp/rootca_ssl_rsa2022.crt). Оба файла совпали побайтно (SHA-256 файла: `936a43fea6e8e525bcc0f81acd9c3d21b4fc4b9b68acea7906d698005afc6504`).
- Отпечаток X.509 SHA-256: `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`. Субъект и издатель — `Russian Trusted Root CA`; `CA:TRUE`, срок действия до 27.02.2032.
- `curl --cacert certs/russian_trusted_root_ca.crt https://platform-api2.max.ru/me` подтвердил TLS (`ssl_verify_result=0`), а без токена ожидаемо получил HTTP 401. Node-клиент с модельным неверным токеном также дошёл до API и получил `Invalid access_token`; модельные тесты — 6/6.
- `node --env-file=.env apps/bot/spike/me.mjs` с настоящим токеном вернул `user_id: 394682891`, `name: Хакатон МАХ 214`, `username: t214_hakaton_max_bot`, `is_bot: true`. Токен не выводился.
- Через `GET /updates` получено новое тестовое сообщение `K05A-VPS-927`; `POST /messages` успешно отправил ответ с inline-кнопкой «Да» в тот же чат. Текст и идентификатор чата в журнал не выводились. Пользователь подтвердил, что ответ и кнопка видны в клиенте MAX. Нажатие кнопки и callback отдельно не проверялись.

Осталось приложить результат живой проверки (без токена и пользовательских сообщений) к Issue #39.

Критерий «`GET /me` возвращает `t214_hakaton_max_bot`; бот отвечает в MAX» считается выполненным только после этих шагов.
