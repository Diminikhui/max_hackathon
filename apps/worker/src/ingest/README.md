# Загрузка проектов regulation.gov.ru (K-18b)

`RegulationIngestJob` получает последние проекты через клиент K-18a, приводит дату к ISO 8601 и сохраняет
нормализованный `RegulationDocument` через порт `DocumentStore`. Записи без заголовка, корректной даты публикации
или HTTP(S)-ссылки не дополняются выдуманными значениями: они перечисляются в `report.rejected`.

```ts
import { PostgresChangeEventRepository } from "@max-hackathon/storage";
import {
  ChangeEventDocumentStore,
  RegulationClient,
  RegulationIngestJob,
  runDailyIngest,
} from "./ingest/index.js";

const job = new RegulationIngestJob({
  source: new RegulationClient(),
  store: new ChangeEventDocumentStore(new PostgresChangeEventRepository(db)),
});
await runDailyIngest(job, { signal });
```

- Первый запуск выполняется сразу, следующие — через 24 часа. После ошибки источника или хранилища повтор идёт через час.
- ID события — `regulation-document:<documentId>`. Идемпотентный `ChangeEventRepository.append` из K-10c не создаёт
  вторую строку при повторном запуске или после перезапуска воркера; первая запись остаётся источником правды.
- Сохраняются исходные `documentId`, ссылка, дата публикации, стадия, сферы портала и `source` с датой получения.
- Сферы портала — не коды ОКВЭД. В нормализованном контракте они остаются строками `sphereIds`.
- Живой источник имеет `isModel: false`. Для тестовой или модельной ленты нужно явно передать `isModel: true`.
- Цикл экспортирован для сборочного потока воркера; `main.ts` находится вне зоны K-18b и здесь не меняется.
