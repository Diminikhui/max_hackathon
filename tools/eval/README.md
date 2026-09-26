# Оценка классификатора K-19e

Инструмент сравнивает сохранённые ответы провайдеров с ручной разметкой и считает отдельно для каждого провайдера:

- coverage и долю полностью совпавших ответов;
- exact-set accuracy и macro-F1 для multi-label типов воздействия;
- accuracy и macro-F1 для срока вступления и отрасли;
- precision, recall, F1 и support по каждому классу.

```bash
pnpm --filter @max-hackathon/classifier-eval eval:model
```

CLI не вызывает внешнюю модель: он оценивает зафиксированный JSON, поэтому один commit всегда даёт одинаковый отчёт. Для реального прогона сохраните ответы каждого провайдера в отдельном элементе `runs[]` файла предсказаний и передайте оба пути:

```bash
node tools/eval/evaluate.mjs \
  --dataset data/fixtures/k19e-classification-sample.json \
  --predictions path/to/provider-runs.json \
  --pretty
```

Фикстура `k19e-model-predictions.json` — только проверка механики метрик. Поле `isModel: true` означает, что числа нельзя выдавать за фактическое качество GigaChat или локальной модели. Реальный benchmark должен фиксировать имя/версию модели, параметры запуска и неизменённые ответы в новом файле.

Разметка согласована с профилем K-19d: `impactTypes` — multi-label массив из `new_obligation`, `changed_obligation`, `removed_obligation`, `new_opportunity`; `effectiveDate` — дата ISO или `null`; `industry` — `food_service`, `auto_service`, `retail`, `cross_industry` или `unknown`. В выборке 32 равномерно распределённых модельных документа — по восемь основных примеров каждого типа воздействия и по восемь документов четырёх известных отраслевых классов.

Пропущенное предсказание снижает coverage, accuracy и exact match. Неизвестный или повторный `documentId`, неполная метка и выборка меньше 30 документов считаются ошибкой входа.
