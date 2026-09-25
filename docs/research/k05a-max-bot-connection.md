# K-05a: подключение бота MAX (`t214_hakaton_max_bot`)

- Дата: 2026-09-25
- Статус: код spike готов, **живая проверка не выполнена** (см. «Что осталось»)
- Код: [`apps/bot/spike/`](../../apps/bot/spike/)

## Что сделано

| Файл | Назначение |
| --- | --- |
| `max-client.mjs` | Клиент Bot API без зависимостей: `GET /me`, `GET /updates` (long polling), `POST /messages` с inline-кнопками, `POST /answers` |
| `me.mjs` | Проверка критерия приёмки: `GET /me` должен вернуть ник `t214_hakaton_max_bot` |
| `echo-bot.mjs` | Приём событий polling'ом, ответ с двумя кнопками `callback`, ответ на нажатие |
| `max-client.test.mjs` | Тесты проверки отпечатка на модельном самоподписанном УЦ |

Решения:

- **Доверие сертификату только процессу.** Сертификат НУЦ передаётся в `https.Agent` клиента вместе со стандартными корнями Node (`tls.rootCertificates`). Системное хранилище не меняется, `NODE_TLS_REJECT_UNAUTHORIZED` не трогается. Альтернатива для сервиса — `NODE_EXTRA_CA_CERTS=$MAX_CA_CERT_PATH`.
- **Проверка отпечатка перед использованием.** Клиент читает `MAX_CA_CERT_PATH`, считает SHA-256 и сравнивает с `MAX_CA_CERT_SHA256`. Без отпечатка или при несовпадении клиент не запускается. Отпечаток в коде не зашит: его записывает тот, кто скачал сертификат и сверил его по двум официальным источникам.
- **Токен только в заголовке `Authorization`** и никогда не выводится; в лог бота пишутся лишь тип события и `chat_id`.
- **Приём событий — long polling** только для разработки. В production — webhook на 443 (K-08, K-22a); при активной подписке polling не работает. Подробно — [k05c-max-bot-api-limits.md](k05c-max-bot-api-limits.md).

## Пример вызовов

```bash
# .env: MAX_BOT_TOKEN, MAX_API_BASE_URL, MAX_CA_CERT_PATH=certs/russian_trusted_root_ca.crt, MAX_CA_CERT_SHA256=<отпечаток>
node --env-file=.env apps/bot/spike/me.mjs         # ожидается "username": "t214_hakaton_max_bot"
node --env-file=.env apps/bot/spike/echo-bot.mjs   # написать боту в MAX, нажать кнопку
node --test apps/bot/spike/                         # модельные тесты отпечатка
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

На компьютере автора устанавливать и скачивать сертификат НУЦ нельзя, поэтому живая проверка переносится на машину, где это допустимо, — в первую очередь на VPS из K-08:

1. Скачать `russian_trusted_root_ca.crt` с `gosuslugi.ru/crt`, сверить SHA-256 по второму официальному источнику, положить в `certs/` (см. [certs/README.md](../../certs/README.md)).
2. Записать отпечаток в `MAX_CA_CERT_SHA256` и в этот документ.
3. Выполнить `me.mjs` и `echo-bot.mjs`, приложить вывод `me.mjs` (без токена) к Issue #39.

Критерий «`GET /me` возвращает `t214_hakaton_max_bot`; бот отвечает в MAX» считается выполненным только после этих шагов.
