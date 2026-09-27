# GigaChat provider (K-19b)

`GigaChatProvider` реализует `LlmProvider`: получает OAuth-токен с `scope=GIGACHAT_API_PERS`, кэширует его до
истечения и вызывает структурированный вывод `POST /v1/chat/completions`. Ответ всё равно считается недоверенным и
повторно проверяется ядром классификатора по JSON Schema.

Провайдер передаёт системные правила и JSON-конверт внешнего документа разными сообщениями, отклоняет схемы с
`anyOf`, `oneOf` или `allOf`, включает `response_format.strict`, повторяет `429` с учётом `Retry-After` и обновляет
OAuth-токен один раз после `401`. Для `GIGACHAT_API_PERS` запросы одного экземпляра выполняются последовательно:
официальный лимит для физических лиц — один поток.

## Конфигурация

- `GIGACHAT_AUTH_KEY` — обязательный Authorization key из кабинета, хранится только в окружении;
- `GIGACHAT_SCOPE` — по умолчанию `GIGACHAT_API_PERS`;
- `GIGACHAT_AUTH_URL` — по умолчанию `https://ngw.devices.sberbank.ru:9443/api/v2/oauth`;
- `GIGACHAT_API_BASE_URL` — по умолчанию `https://api.giga.chat/v1/`;
- `GIGACHAT_MODEL` — по умолчанию `GigaChat-2`.

Корневой сертификат НУЦ Минцифры добавляется только процессу Node до запуска:

```sh
NODE_EXTRA_CA_CERTS="$PWD/certs/russian_trusted_root_ca.crt" node apps/worker/dist/main.js
```

Проверка TLS не отключается. Ключ не включается в URL, сообщения об ошибках или тестовые данные.

## Ограничения, которые стоит знать

- **Повторы `429` и таймаут ядра.** Провайдер ждёт `Retry-After` до 60 с и повторяет до 2 раз, но
  `classifyDocument` отдаёт `template`, если ответ не пришёл за 30 с (`DEFAULT_TIMEOUT_MS` в `core/classifier.ts`).
  Поэтому повтор имеет смысл только при коротком `Retry-After`; при длинном результатом будет `template` с
  `usedFallback: true`. Менять один из таймаутов нужно вместе с другим.
- **`expires_at` токена.** Значение меньше 10^10 считается секундами, больше — миллисекундами: в примерах API
  встречаются оба варианта. Ошибка в единицах безопасна — токен обновится раньше срока или после `401`, который
  провайдер обрабатывает одним повтором.

## Использование и fallback

```ts
const provider = gigachatProviderFromEnv();
const result = await classifyDocument(document, provider, REGULATORY_IMPACT_PROFILE);
```

Если ключ отсутствует, OAuth/API недоступны, GigaChat вернул ошибку/не-JSON либо результат не прошёл схему,
`classifyDocument` автоматически возвращает детерминированный `template` с `usedFallback: true`.

Живая проверка с явно модельным документом (ничего секретного и ответ модели в вывод не попадают):

```sh
pnpm build
NODE_EXTRA_CA_CERTS="$PWD/certs/russian_trusted_root_ca.crt" \
  node packages/classifier/dist/gigachat/smoke.js
```

Команда завершается с ошибкой, если ключ/сеть недоступны, ответ не соответствует схеме или сработал `template`.

Актуальные на 27.09.2026 официальные условия: access token действует 30 минут; OAuth допускает до 10 запросов/с;
для физлица доступен один поток, для ИП/юрлица по умолчанию 10; модели GigaChat 2 имеют контекст до 128 тыс.
токенов. Конкретная квота токенов зависит от тарифа и проверяется в кабинете, поэтому в коде она не зашита.

Официальные источники: [авторизация и URL API](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/gigachat-api),
[structured output](https://developers.sber.ru/docs/ru/gigachat/guides/structured-output),
[квоты и потоки](https://developers.sber.ru/docs/ru/gigachat/limitations),
[сертификаты НУЦ Минцифры](https://developers.sber.ru/docs/ru/gigachat/certificates).
