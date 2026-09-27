# Сценарная копия профиля

`ScenarioProfileService` создаёт временное состояние для сценария «Что будет,
если…». Сервис читает реальный профиль через `ProfileRepository.get`, глубоко
копирует его и добавляет факты с `kind: "scenario"`. Он не вызывает методы
сохранения репозитория и не изменяет объект, который вернул репозиторий.

Сценарное состояние явно помечено `isModel: true`, а каждый добавленный факт —
источником `scenario` с `source.isModel: true`. Передавать такую копию в
rule-engine нужно только с `mode: "scenario"`; в обычном режиме эти факты
игнорируются.

```ts
const outcome = await scenarios.create("company-1", [
  { key: "employment.has_employees", value: true },
]);

if (outcome.status === "ok") {
  assessRequirement(requirement, outcome.scenario.profile, {
    evaluatedAt: outcome.scenario.createdAt,
    mode: "scenario",
  });
}
```

Повторяющиеся ключи в одном сценарии отклоняются, чтобы выбор значения не
зависел от идентификатора факта. Возможные старые сценарные факты из исходного
профиля в новую копию не переносятся.
