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
- `listNpa` сначала читает `total`, затем запрашивает последние `limit` записей по `offset`.
- XML разбирается собственным парсером без DTD и внешних сущностей.

## Проверка на живом портале

26.09.2026 сверены XML `/api/npalist/` и JSON `GetFiltered`. Для `GetFiltered` портал принимает `listParams.filterModel` и `orderedFields`; тестовые ответы остаются модельными. Портал может изменить API без предупреждения, поэтому неизвестная форма JSON вызывает ошибку источника вместо пустой выборки.
