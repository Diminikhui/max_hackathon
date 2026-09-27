# 5-07: резервное копирование и восстановление

Что защищаем: базу PostgreSQL сервиса `database` из `compose.yaml` (профили компаний, факты, результаты применимости, подписки на уведомления). Код восстанавливается из Git, секреты — из `/etc/max-hackathon/` (см. [deploy.md](../deploy.md)); в резервные копии они не попадают.

Цели — в [sla.md](sla.md): **RPO ≤ 24 ч**, **RTO ≤ 1 ч**.

## Как устроено

| Компонент | Что делает |
|---|---|
| [`deploy/backup/max-backup.sh`](../../deploy/backup/max-backup.sh) | `pg_dump --format=custom` внутри контейнера `database`, проверка архива `pg_restore --list`, файл `*.sha256`, хранение `BACKUP_KEEP` последних копий |
| [`deploy/backup/max-restore.sh verify`](../../deploy/backup/max-restore.sh) | Учения по восстановлению: проверяет свежесть последней копии (`BACKUP_MAX_AGE_HOURS`) и контрольную сумму, восстанавливает во временную БД `restore_check_*`, сверяет число таблиц с архивом, удаляет временную БД, пишет длительность |
| `deploy/backup/max-restore.sh restore <копия> --yes` | Восстановление рабочей БД: страховочная копия текущего состояния, остановка `bot worker miniapp-api`, `pg_restore --clean --single-transaction`, запуск сервисов |
| `max-hackathon-backup.timer` | Копия ежедневно в 03:30 МСК (`Persistent=true`: пропущенный запуск выполнится после загрузки) |
| `max-hackathon-restore-check.timer` | Учения ежедневно в 04:30 МСК |
| [`deploy/backup/test-backup-restore.sh`](../../deploy/backup/test-backup-restore.sh) | Сквозная проверка обоих скриптов на одноразовом контейнере Postgres с модельными данными |

Пароль БД скриптам не нужен: команды выполняются внутри контейнера через локальный сокет под `POSTGRES_USER`.

**Оповещения.** Оба задания хранят состояние в `/var/lib/max-hackathon/{backup,restore-check}-state` и отправляют сообщение в MAX тем же способом и тому же получателю (`MAX_ALERT_CHAT_ID`), что и `vps-monitor.sh`: при сбое и при восстановлении, без повторов на каждом цикле. Если таймер копий перестал работать, ежедневные учения сообщат об устаревшей копии.

## Установка на VPS

```bash
cd /srv/max-hackathon/repo
sudo install -d -m 0750 /usr/local/lib/max-hackathon/backup
sudo install -m 0750 deploy/backup/lib.sh deploy/backup/max-backup.sh deploy/backup/max-restore.sh /usr/local/lib/max-hackathon/backup/
sudo install -m 0644 deploy/systemd/max-hackathon-backup.* deploy/systemd/max-hackathon-restore-check.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now max-hackathon-backup.timer max-hackathon-restore-check.timer
sudo systemctl start max-hackathon-backup.service max-hackathon-restore-check.service
journalctl -u max-hackathon-backup.service -u max-hackathon-restore-check.service -n 20 --no-pager
```

Как и монитор, скрипты запускаются из установленной копии, а не из checkout: изменения из `main` не попадают в задания без повторной установки. Необязательные настройки — в `/etc/max-hackathon/backup.env` (права `0600`), переменные описаны в `.env.example`: `BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_MAX_AGE_HOURS`.

## Восстановление после инцидента

1. Выберите копию: `ls -l /var/lib/max-hackathon/backups/`. Время в имени — UTC.
2. Проверьте её без риска: `sudo /usr/local/lib/max-hackathon/backup/max-restore.sh verify /var/lib/max-hackathon/backups/<копия>.dump`.
3. Восстановите: `sudo /usr/local/lib/max-hackathon/backup/max-restore.sh restore /var/lib/max-hackathon/backups/<копия>.dump --yes`. Скрипт сначала сохранит `max-hackathon-pre-restore-*.dump` и напечатает команду отката.
4. Проверьте работу: `sudo /usr/local/sbin/max-hackathon-monitor` и сценарий в боте.
5. Повторите запросы на удаление данных пользователей, поступившие после времени копии: восстановление возвращает удалённое.
6. Запишите в Issue инцидента время обнаружения, копию, длительность восстановления и потерянный интервал.

Если сломан сам контейнер `database` или том `postgres-data`: `docker compose --env-file /etc/max-hackathon/compose.env up -d database`, дождитесь `healthy`, затем шаг 3 (пустая БД восстанавливается тем же способом).

## Локальная проверка

```bash
./deploy/backup/test-backup-restore.sh
```

Нужен Docker. Проверка поднимает `postgres:17-alpine`, создаёт модельные таблицы и проверяет: ротацию, учения, отказ при устаревшей копии и неверной сумме, отчёт о сбое копирования, требование `--yes`, восстановление после потери данных и откат по страховочной копии.

## Ограничения

- **Копии хранятся на том же VPS.** Они защищают от ошибочной миграции, удаления данных и порчи БД, но не от потери сервера или диска. Вынос копий во внешнее хранилище (например, объектное хранилище Selectel с шифрованием) требует решения команды о месте хранения ПДн и ключах; до него риск принят на период хакатона.
- Копии содержат идентификаторы пользователей MAX и данные компаний. Права `0600`, хранение `BACKUP_KEEP` дней (по умолчанию 7), копии не передаются вне VPS и не публикуются.
- Учения сверяют структуру (число таблиц), а не содержимое строк; содержимое проверяет `pg_restore --exit-on-error`.
- До установки на VPS (раздел выше) расписание не работает: это действие владельца сервера.
