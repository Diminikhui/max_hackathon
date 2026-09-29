# Сценарий настроек уведомлений (K-24c)

Обработчики маршрутов машины диалога K-22b `show_notification_settings` и `notification_settings_saved`, кнопки «Отключить / включить уведомления» и «Отключить / включить ранние сигналы».

## Подключение

```ts
const settingsStore = createMemorySettingsStore(); // до базы данных; в worker передаётся тот же объект
const settingsFlow = createSettingsFlow({
  settings: settingsStore,
  companyOf: async (dialogId) => sessions.companyOf(dialogId), // компания после онбординга K-24a
});
const router = createDialogRouter<FlowReply>({ ...otherHandlers, ...settingsFlow.handlers });

// В обработчике транспорта K-22a (`handle({ event, dialogEvent })`):
if (dialogEvent === undefined && event.kind === "callback") {
  const action = decodeSettingsPayload(event.payload);
  if (action !== undefined) return settingsFlow.handleAction({ router, dialogId, action });
}
```

`handleAction` сохраняет итоговые настройки и проводит через машину системное событие `notification_settings_saved`. Как и у остальных сценариев, сохраняйте `result.stateOverride ?? transition.state`.

## Кнопки

Payload — `s:<действие>`: `disable_all`, `enable_all`, `disable_early`, `enable_early`. Транспорт K-22a такую кнопку событием машины не считает (`decodeButtonPayload` → `undefined`), поэтому `notification_settings_saved` из кнопки подделать нельзя. Каждое действие задаёт итоговое значение, а не переключает его: повторное нажатие или кнопка из старого сообщения ничего не ломают. Кнопка из старого сообщения срабатывает в любом состоянии диалога: отключение должно действовать всегда.

## Как отключение доходит до отправки

`NotificationSettingsStore.settingsFor` совпадает с портом `NotificationSettingsSource` конвейера уведомлений K-30a. Один объект хранилища передаётся и в бот, и в worker: политика K-20b читает настройки перед каждым прогоном и при `enabled: false` подавляет все причины с кодом `notifications_disabled`, при `earlySignals: false` — только ранние сигналы (`early_signals_disabled`). Тест `apps/bot/test/flows/settings/flow.test.ts` проверяет это на `decide` из worker.

Тип `NotificationSettings` повторяет тип K-20b: worker зависит от бота, а не наоборот.

## Нештатные случаи

| Случай | Ответ | `stateOverride` |
|---|---|---|
| Диалог не знает компанию | «Сначала укажите ИНН» и кнопка «Ввести ИНН»; ничего не сохраняется | `idle` |
| Настроек для компании нет | Значения по умолчанию: всё включено | — |

## Ограничения

- `createMemorySettingsStore` живёт в памяти процесса: после перезапуска настройки сбрасываются на «всё включено». Хранение в базе данных — при сборке контура (K-30b) или отдельным потоком.
- Лимит уведомлений в месяц на экране не показывается числом: он задаётся конфигурацией worker (`monthlyLimit`).
