# `pack add`

Команда устанавливает прошедший K-15c-валидацию JSON-пакет в файловый реестр. Направление и регион задаются содержимым пакета и его условий; для подключения нового варианта код менять не нужно.

```bash
pnpm --filter @max-hackathon/pack-cli exec pack add ./new-pack.json
pnpm --filter @max-hackathon/pack-cli exec pack add ./new-pack.json --registry ./data/rulepacks/installed
```

По умолчанию каталог берётся из `RULEPACK_DIRECTORY` или равен `data/rulepacks/installed`. Реестр хранит версии как `<packId>/<packVersion>.json`, а `manifest.json` указывает активную версию. Невалидный пакет не меняет реестр. Повтор той же версии с тем же содержимым идемпотентен; другое содержимое или откат версии отклоняются.
