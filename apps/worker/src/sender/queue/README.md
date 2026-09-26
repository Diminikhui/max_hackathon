# MAX sender composition

`RateLimitedMaxTransport` — единственная HTTP-граница этого модуля. Composition root обязан создать
один экземпляр на MAX token и передать его в `MaxMessageSender`, upload- и service-клиенты. Эти клиенты
не должны принимать `fetch` или callback запроса: каждый вызов `send`, `upload` или `service` резервирует
один token общей квоты и выполняет ровно один HTTP-запрос.

`SendQueueWorker` требует `SendQueueRepository.listQueuedFair`. Запрос обязан возвращать round-robin
между чатами, сохранять FIFO внутри чата и соблюдать `maxScan`. Старый `listQueued(limit)` не обеспечивает
fairness, если чат B находится за длинным префиксом чата A, поэтому напрямую подключать обычный
`NotificationRepository` нельзя. Реализация fair query в production storage находится вне зоны K-21a;
до неё гарантия fairness относится только к данному контракту и тестовой indexed-реализации.
