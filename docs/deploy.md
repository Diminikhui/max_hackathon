# K-08: VPS, HTTPS и автоматическое развёртывание

Ответственный за сервер и доступность до 14.10.2026: **@Diminikhui**. Сервер Selectel (Москва), Ubuntu 24.04, `135.106.227.207`. Публичный адрес мини-приложения: <https://135.106.227.207/>. Домен не покупался: сертификат Let's Encrypt выпущен непосредственно на IP; браузер проверяет IP в SAN сертификата. Приватный ключ сертификата хранится только на VPS.

## Доступ к коду и поток изменений

В настройках GitHub репозитория установлен deploy key **Selectel clotilde K-08 read-only**, отпечаток `SHA256:8pXmKICOuBQ6PsTE3qOcBO5NP9iWtYinvFV9uBaAI8c`. Приватный ключ `/root/.ssh/k08_deploy_ed25519` создан и хранится только на VPS. Он позволяет серверу читать один репозиторий, но не пушить коммиты. Другим агентам SSH-доступ к VPS не нужен: они работают в своих ветках, проходят PR и после слияния в `main` изменения подхватывает `max-hackathon-deploy.timer` раз в пять минут. Таймер не развёртывает ветки PR.

Production checkout: `/srv/max-hackathon/repo`; код разработки K-08: `/opt/max-hakaton-k08`. Секреты находятся вне Git: `/etc/max-hackathon/compose.env`, `bot.env`, `monitor.env` (права `0600` или `0640` по необходимости). `POSTGRES_PASSWORD` сгенерирован на сервере. Порты мини-приложения `4173` и API `3000` привязаны к `127.0.0.1`, снаружи открыт только Nginx на 80/443 и SSH на 22.

`deploy/vps-deploy.sh` читает только `origin/main`, собирает и запускает `compose.yaml`, проверяет HTTPS и записывает SHA в `/var/lib/max-hackathon/deployed-sha`. При ошибке перехода на новый SHA пытается вернуть прежнюю версию. Для ручного запуска: `sudo systemctl start max-hackathon-deploy.service`. Состояние: `systemctl status max-hackathon-deploy.timer` и `journalctl -u max-hackathon-deploy.service -n 100 --no-pager`. Никакой агент не должен помещать `.env`, токен MAX или закрытый ключ в репозиторий.

## HTTPS без домена

Certbot 5.8 установлен в `/opt/certbot-k08`; сертификат: `/etc/letsencrypt/live/135.106.227.207/fullchain.pem`, ключ: `privkey.pem`. Использован HTTP-01 webroot `/var/www/html`. `deploy/nginx-ip.conf` обслуживает challenge на 80 и проксирует HTTPS на локальные сервисы. IP-сертификат действует около шести дней, поэтому `k08-cert-renew.timer` проверяет его дважды в сутки и после успешного продления перезагружает Nginx. Пробное продление `certbot renew --dry-run` прошло 26.09.2026.

Проверки:

```bash
curl -fsS -o /dev/null -w 'http=%{http_code} tls=%{ssl_verify_result}\n' https://135.106.227.207/
openssl x509 -in /etc/letsencrypt/live/135.106.227.207/fullchain.pem -noout -dates -ext subjectAltName
systemctl list-timers k08-cert-renew.timer max-hackathon-deploy.timer
```

Проверка TLS не отключается. Публичный сертификат НУЦ Минцифры используется только процессом MAX-клиента на VPS и не устанавливается в системное хранилище Mac.

## Бот и webhook

Пока `apps/bot/src/main.ts` пустой, на VPS работает **временный тестовый** K-05a `echo-bot.mjs` через long polling: `k08-spike-bot.service`, пользователь `maxbot`, автоматический перезапуск. Это проверяет, что бот отвечает без компьютера команды, но не является продуктовым транспортом. При появлении K-22a его следует заменить серверным обработчиком `/webhook` на `127.0.0.1:3001`, остановить polling-службу, создать MAX webhook-подписку на `https://135.106.227.207/webhook` с `secret` и включить `MAX_INGEST_MODE=webhook` в `/etc/max-hackathon/monitor.env`. На VPS только один процесс должен получать события MAX с данным токеном. `GET /subscriptions` проверяется монитором после перехода в режим webhook.

Документация MAX требует HTTPS/443, доверенную цепочку и совпадение имени URL с сертификатом. IP в SAN проверяется браузером, но приём **буквального IP URL платформой MAX ещё не подтверждён**. До успешного `POST /subscriptions` не выключайте polling. Если MAX отклонит IP, потребуется отдельное решение с DNS-именем; домен покупать необязательно, но это изменит требование «без домена». Владелец должен согласовать такой вариант.

## Мониторинг и сбой

`deploy/vps-monitor.sh` проверяет HTTPS, срок сертификата, таймеры, Nginx, Docker, здоровье пяти контейнеров и работу текущего транспорта MAX. В режиме webhook дополнительно сверяет адрес в `GET /subscriptions`. `max-hackathon-monitor.timer` запускает проверку раз в две минуты. При изменении состояния монитор пишет журнал и, если указан подтверждённый `MAX_ALERT_CHAT_ID`, отправляет владельцу сообщение MAX о сбое или восстановлении. Хранение последнего состояния предотвращает повторные оповещения на каждом цикле. Проверка отправки: `sudo /usr/local/sbin/max-hackathon-monitor --test-alert`.

При инциденте:

1. Проверьте `systemctl status nginx docker k08-spike-bot max-hackathon-deploy.timer k08-cert-renew.timer max-hackathon-monitor.timer` и `curl -fsS https://135.106.227.207/`.
2. Посмотрите `journalctl -u max-hackathon-monitor.service -u max-hackathon-deploy.service -u k08-spike-bot.service -n 100 --no-pager` и `docker compose --env-file /etc/max-hackathon/compose.env ps` в `/srv/max-hackathon/repo`. Не публикуйте вывод с токенами или сообщениями пользователей.
3. При недоступности мини-приложения: `systemctl start max-hackathon-deploy.service`; при проблеме нового SHA проверьте `/var/lib/max-hackathon/deployed-sha` и журнал отката.
4. При истечении сертификата: проверьте порт 80 и `systemctl start k08-cert-renew.service`, затем `nginx -t && systemctl reload nginx`.
5. При недоступности бота: проверьте, какой режим включён. Для polling перезапустите `k08-spike-bot.service`; для webhook проверьте локальный обработчик, секрет и `GET /subscriptions` через API MAX. Не запускайте polling одновременно с активной подпиской.

## Ограничения на 27.09.2026

HTTPS и Compose работают; мини-приложение открывается, но его текущий `main.tsx` выводит пустой `<main />`, а API и бот имеют пустые точки входа. Пользовательский сценарий появится после соответствующих потоков. До K-22a работает явно тестовый polling K-05a. Не представляйте его как готовый webhook или готовый пользовательский сценарий.
