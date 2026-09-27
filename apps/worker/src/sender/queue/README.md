# MAX sender composition

`RateLimitedMaxTransport` — единственная HTTP-граница этого модуля. Composition root обязан создать
один экземпляр на MAX token и передать его в `MaxMessageSender`, upload- и service-клиенты. Эти клиенты
не должны принимать `fetch` или callback запроса: каждый вызов `send`, `upload` или `service` резервирует
один token общей квоты и выполняет ровно один HTTP-запрос.

`SendQueueWorker` требует `SendQueueRepository.listQueuedFair`: round-robin между чатами, FIFO внутри чата
и не больше `maxScan` прочитанных записей. Production-реализация — `PostgresNotificationRepository.listQueuedFair`
(`@max-hackathon/storage`, миграция `k-21a-001`): чаты перебираются skip scan-ом по индексу
`notifications_queue_by_chat` с курсором по кругу, поэтому длинная очередь одного чата не загораживает другие.

Сборка — `createMaxSenderRuntime` (`composition.ts`): берёт transport из `MaxTransportRegistry` (один на token
в процессе) и создаёт на нём `MaxMessageSender`, `MaxUploadClient`, `MaxServiceClient` и воркер. Тест
`composition.test.ts` проверяет, что `fetch` вызывается только в `max-transport.ts`.
