# Каркас мини-приложения (2-01a)

MAX UI, MAX Bridge, тема, навигация и адаптация под web и mobile. Экраны подключают свои потоки.

```text
index.html ── max-web-app.js ──► window.WebApp
main.tsx ── readLaunchContext(getBridge()) ──► AppShell
                                               ├─ MaxUI (платформа ios/android, тема — системная)
                                               └─ AppProvider (стек экранов, BackButton, ready())
                                                    └─ SCREENS[route.screen]
```

## Файлы

| Файл | Что делает |
|---|---|
| `bridge.ts` | Типы Bridge и `readLaunchContext`: запущено ли из MAX, платформа, `start_param`, `initData` |
| `runtime.ts` | `getBridge()` и `openExternalLink()` — доступ к `window` |
| `navigation.ts` | Стек экранов без React: `push`, `back`, `reset`, начальный экран по deep link |
| `AppContext.tsx` | `AppProvider` и хук `useApp()`; связывает стек с системной кнопкой «Назад» MAX |
| `AppShell.tsx` | Корень: провайдер MAX UI, заголовок, модельная плашка, текущий экран |
| `screens.tsx` | Реестр экранов `SCREENS`; главный экран и заглушки 2-02, 2-03, 2-05 |
| `shell.css` | Безопасные зоны устройства, ширина до 640 px на широком экране |

## Как подключить экран

1. Сделайте компонент в своей зоне (`apps/miniapp/src/profile/` и т. п.) из компонентов `@maxhub/max-ui`.
2. Замените заглушку в `SCREENS` на свой компонент. Новый экран — новое значение `ScreenId` в `navigation.ts`.
3. Внутри экрана: `const { push, back, openLink, launch } = useApp();`
   - `push({ screen: "checklist", params: { id } })` — переход; параметры непрозрачные, без ПДн;
   - `openLink(url)` — ссылка на первоисточник: в MAX через `WebApp.openLink`, вне MAX — новая вкладка.

## Поведение

- **Запуск из MAX** определяется по непустому `initData`. Вне клиента скрипт Bridge тоже создаёт `window.WebApp`, но с `null` в полях; такой Bridge не используется.
- **Вне MAX** показывается плашка «Модельный режим» и своя кнопка «Назад». Подпись пользователя здесь не проверяется: проверка `initData` — только на сервере (2-01b, K-32b).
- **«Назад» в MAX** — системная кнопка клиента (`WebApp.BackButton`): видна, пока в стеке больше одного экрана.
- **Тема**: Bridge тему не передаёт, MAX UI берёт светлую или тёмную из системы. Платформа `ios`/`android` передаётся в MAX UI; для `web` и `desktop` провайдер выбирает сам.
- **Deep link** `?startapp=profile|checklist|settings` открывает экран поверх главного. Кнопка MAX `open_app` передаёт `requirement_<UTF-8 hex id>` и открывает перечень с `params.requirementId`; в payload нет ПДн. Некорректный `start_param` безопасно ведёт на главный экран. До проверки подписи параметр используется только для навигации.

## Запуск

```bash
pnpm --filter @max-hackathon/miniapp dev    # http://localhost:5173, модельный режим
pnpm --filter @max-hackathon/miniapp test
```

MAX UI требует `react@19.2.8` в `peerDependencies`, в проекте `^19.3.0`: pnpm предупреждает, сборка и работа проверены. Лицензия в репозитории MAX UI не указана.
