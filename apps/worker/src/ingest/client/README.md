# Клиент regulation.gov.ru (K-18a)

```ts
import { RegulationClient } from "./index.js";

const client = new RegulationClient(); // baseUrl, fetch, minIntervalMs, maxRetries, timeoutMs — настраиваются
const latest = await client.listNpa({ limit: 500 });                              // /api/npalist/ (XML)
const cafes = await client.getFiltered({ sphereIds: [23], titleContains: "общественного питания" }); // GetFiltered
```

- Возвращает `NpaProject` — сырой проект портала, не `ChangeEvent`; преобразование и отбор — K-18b/K-18c.
- `sphereIds` — сферы портала (поле `okveds`), **не коды ОКВЭД** (ADR-0006).
- Записи без идентификатора пропускаются и считаются в `skipped`; пустые поля отбрасываются.
- Страницы до 500; выборка останавливается на неполной странице, по `total` или по `maxPages` (по умолчанию 20).
- Между запросами пауза `minIntervalMs` (1 с). 429, 5xx, сетевые сбои и таймауты повторяются (`Retry-After` или backoff ×2), остальное — сразу ошибка. Коды ошибок совпадают с каталогом K-27.
- XML разбирается собственным парсером без DTD и внешних сущностей.

## Ограничение

Портал был недоступен из среды разработки, поэтому имена полей и параметры GetFiltered (`filters`, `sorts`, `page`, `pageSize`) взяты из проверки 22–23.09 (docs/proposals/2026-09-23-gaps-and-proposals.md, п. 4) и поддержаны несколькими вариантами имён. Тесты работают на модельных ответах. Перед K-18b нужно один раз прогнать клиент на живом портале и при расхождении поправить `FIELDS` в `normalize.ts`.
