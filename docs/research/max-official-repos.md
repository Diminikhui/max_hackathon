# Официальные репозитории MAX, которые берём в проект

- Дата: 2026-09-28
- Статус: справка, решений не меняет
- Связано: [ADR-0005](../decisions/0005-stack-and-repository-layout.md), [K-05a](k05a-max-bot-connection.md), [K-05b](k05b-max-miniapp-launch.md), [K-05c](k05c-max-bot-api-limits.md)

Наш стек — TypeScript, Node.js 24, React 19 и Vite (ADR-0005). Из опубликованных репозиториев MAX под него подходят три. Библиотеки на Go, Python и Java не берём: другой язык требует отдельного ADR. Версии указаны на день проверки через GitHub API.

| Репозиторий | Что это | Как берём | Задачи |
| --- | --- | --- | --- |
| [max-messenger/max-ui](https://github.com/max-messenger/max-ui) | React-компоненты интерфейса MAX, npm `@maxhub/max-ui` 0.5.0 | Зависимость мини-приложения | 2-01a — подключение; 2-02, 2-03, 2-04, 2-05, 2-11, 2-12 — экраны, состояния и адаптация |
| [max-messenger/api-schema](https://github.com/max-messenger/api-schema) | OpenAPI 3.0 схема Bot API, версия 0.0.33 | Справочник полей и, по решению потока, источник типов | K-24a, K-30b, 2-10 — сообщения и кнопки; K-30d — сверка с живым API |
| [max-messenger/max-bot-api-client-ts](https://github.com/max-messenger/max-bot-api-client-ts) | TypeScript SDK Bot API, npm `@maxhub/max-bot-api` 0.3.1, MIT | Образец кода, не зависимость | Те же, что у схемы |

## MAX UI

ADR-0005 уже выбирает MAX UI для мини-приложения; подключает её поток 2-01a, экранные потоки используют компоненты из каркаса.

- Установка — в пакет мини-приложения: `pnpm --filter @max-hackathon/miniapp add @maxhub/max-ui`.
- `peerDependencies` требуют ровно `react@19.2.8` и `react-dom@19.2.8`, у нас `^19.3.0`. pnpm выдаст предупреждение. Совместимость проверяется сборкой и запуском в 2-01a; React ради библиотеки не откатываем без явной поломки.
- В репозитории не указана лицензия — отметить в PR 2-01a.

## OpenAPI-схема Bot API

Описывает методы, типы update, вложения и кнопки, в том числе `link` и `open_app` для deep links.

- Сверять с ней транспорт (`apps/bot/src/transport/`) и отправитель (`apps/worker/src/sender/max/`) при изменении форматов сообщений и кнопок.
- Генерация типов (`openapi-typescript`) допустима как решение потока, без смены HTTP-клиента.
- K-05c опирается на схему 0.0.32 из [max-messenger-bot/max-bot-api-schemas](https://github.com/max-messenger-bot/max-bot-api-schemas); расхождения с 0.0.33 не проверялись.

## TypeScript SDK

Свой клиент не заменяем: он доверяет сертификату НУЦ только процессу приложения, проверяет отпечаток, ограничивает скорость и сводит ошибки к таксономии K-27. Переход на SDK — переделка работающего кода и отдельная проверка, можно ли передать SDK свой `https.Agent`, не нарушая правило 11 из [TEAM_GUIDE](../../TEAM_GUIDE.md). SDK полезен как пример типов событий, формата кнопок и `POST /answers`.
