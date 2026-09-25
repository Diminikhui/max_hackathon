# CLI-валидатор пакетов правил

Проверяет пакет правил по схемам K-15a и K-15b, а затем по правилам публикации,
которые JSON Schema выразить не может: совпадение версий и `packId`, уникальность
`Requirement.id`, согласованность периодов действия и маркировки модельных данных.

Все данные пакета считаются недоверенным вводом. Валидатор ничего не публикует и
не меняет исходный файл.

## Запуск

После `pnpm install` из корня репозитория:

```bash
node tools/rulepack-validate/rulepack-validate.mjs \
  contracts/rulepack/pack/examples/model-cafe.json
```

Корректный пакет печатает путь и завершает работу с кодом `0`. Некорректный пакет
завершается с кодом `1` и печатает все найденные причины в `stderr`.

## Проверка

```bash
node --test tools/rulepack-validate/rulepack-validate.test.mjs
```

## Тесты и зависимости

Инструмент — пакет workspace `@max-hackathon/rulepack-validate` со своими зависимостями (`ajv`, `ajv-formats`). Тесты (`node --test`) входят в общий `pnpm test`, поэтому выполняются в CI (`pnpm --filter @max-hackathon/rulepack-validate test` — только они).

Номер версии относительно уже опубликованных (новая версия строго больше) валидатор проверить не может: это делает `PostgresRequirementRepository.saveVersion` (K-10b).
