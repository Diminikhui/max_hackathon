# Сервис перечня

`ChecklistService` превращает сохранённый профиль компании и последние версии опубликованных пакетов правил в один перечень со статусами применимости.

По умолчанию сервис получает идентификаторы через `RequirementRepository.listPackIds()`. Поэтому новый пакет — в том числе пакет общепита — подключается публикацией в репозиторий и не требует ветки по `packId` в коде. Для ограниченного перечня можно передать `packIds` в `build`.

```ts
const service = new ChecklistService({ profiles, requirements });
const outcome = await service.build(companyId);

if (outcome.status === "ok") {
  for (const { requirement, applicability } of outcome.checklist.items) {
    console.log(requirement.title, applicability.status);
  }
}
```

Сервис сначала фиксирует последнюю версию каждого пакета, затем читает именно её. Все записи одного вызова получают одинаковые `evaluatedAt` и `asOf`. Порядок пакетов детерминирован по `packId`, порядок записей внутри пакета сохраняется из репозитория.
