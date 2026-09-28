# Реестр покрытия и история расчётов (4-13)

`CoverageHistoryService` воспроизводит перечень на дату `asOf` только по снимкам, которые система уже знала к концу этой даты:

1. выбирает последний снимок профиля с `recordedAt <= asOf`;
2. для каждого пакета выбирает последнюю опубликованную и действующую на дату версию;
3. вычисляет каждое требование существующим `assessRequirement` с тем же `asOf`;
4. возвращает версии пакетов, время снимка профиля, статусы и цепочки объяснения с источниками.

```ts
const registry = new MemoryCoverageHistoryRegistry(); // модельный append-only реестр
await registry.appendProfile(profileSnapshot);
await registry.appendRulepack(rulepackSnapshot);

const service = new CoverageHistoryService({ history: registry });
const result = await service.reproduce("company:model-cafe", { asOf: "2026-01-15" });
```

Снимки неизменяемы: реестр делает копию при записи и чтении, повтор версии пакета и повтор профиля в тот же `recordedAt` отклоняются. Позднее исправление добавляется новым снимком и не переписывает прошлый результат. Все фикстуры тестов модельные.

`MemoryCoverageHistoryRegistry` предназначен для этапа 4 и тестов. Промышленная реализация портов `CoverageHistoryReader`/`CoverageHistoryWriter` должна хранить неизменяемые снимки в российском контуре, обеспечивать резервное копирование и аудит доступа. Контракты v1 и существующие таблицы K-10a/K-10b не меняются.
