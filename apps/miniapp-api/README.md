# Внутренний API мини-приложения

API обслуживает только собственное мини-приложение и не заявляется как публичный API. Полное описание методов —
[`contracts/miniapp-api.yaml`](../../contracts/miniapp-api.yaml).

1. Клиент передаёт строку `WebApp.initData` в `POST /v1/session`.
2. Сервер проверяет подпись и возраст данных через `@max-hackathon/security`, находит компанию по подписанному
   идентификатору диалога и выдаёт случайный токен не дольше чем на один час.
3. Остальные методы принимают `Authorization: Bearer <token>`. Идентификатор компании из клиента не принимается.

Методы: `GET /v1/profile`, `GET /v1/checklist`, `GET|PUT /v1/settings`, `DELETE /v1/session`, `GET /health`.
Неподписанные, испорченные и просроченные данные получают одинаковый ответ `401 UNAUTHENTICATED`.

Локальный запуск требует `MAX_BOT_TOKEN`, `DATABASE_URL` и при необходимости `MINIAPP_API_PORT` (по умолчанию 3000):

```bash
pnpm --filter @max-hackathon/miniapp-api build
pnpm --filter @max-hackathon/miniapp-api start
```

В тестах используются только модельные данные и подпись `signInitDataForTest`; реальные токены и идентификаторы в
репозиторий не попадают.
