# MAX sender (K-21b)

`MaxMessageSender` реализует порт `MessageSender` из `sender/queue`: отправляет текст и inline-кнопки методом
`POST /messages?chat_id=…` через общий `MaxApiTransport` (`sender/queue/max-transport.ts`) и возвращает ошибки без
исключений. Собственного `fetch`, токена и базового URL у клиента нет: их держит транспорт, поэтому отправка делит
квоту MAX с upload- и service-клиентами, а токен передаётся только в заголовке `Authorization`.

```ts
const transport = defaultMaxTransportRegistry.forToken({ token, baseUrl });
const sender = new MaxMessageSender({ transport });
```

HTTP-ответы отображаются в стабильные коды K-27 (`INVALID_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `RATE_LIMITED`, `DEPENDENCY_TIMEOUT`, `DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`). Для `429`
учитывается `Retry-After`. Сетевая ошибка или таймаут после начала запроса возвращаются как `delivery_unknown`
без автоматического повтора: иначе одно уведомление могло бы отправиться дважды.

## Конфигурация и TLS

- `MAX_BOT_TOKEN` и `MAX_API_BASE_URL` читает точка входа процесса и передаёт в транспорт (`MaxTransportRegistry`);
  токен не логируется и не включается в URL;
- сертификат НУЦ Минцифры подключается процессу Node через `NODE_EXTRA_CA_CERTS`, проверка TLS не отключается.

Пример запуска собранного приложения:

```sh
NODE_EXTRA_CA_CERTS="$MAX_CA_CERT_PATH" node apps/worker/dist/main.js
```

Переменная должна быть установлена до запуска Node: изменение `NODE_EXTRA_CA_CERTS` внутри работающего процесса не
обновляет его список доверенных корней.

## Живая проверка

Живую отправку выполняйте только в согласованный тестовый чат. Не печатайте токен и chat ID в вывод и не сохраняйте
их в репозитории. Форма запроса и inline-кнопка уже проверены на выданном боте в K-05a; модульные тесты этого
клиента используют только модельные ответы и идентификаторы.
