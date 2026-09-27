// Spike K-05a: GET /me с проверкой сертификата. Токен не выводится.
// Запуск: node --env-file=.env apps/bot/spike/me.mjs
import { clientFromEnv } from "./max-client.mjs";

const EXPECTED_USERNAME = "t214_hakaton_max_bot";

const client = clientFromEnv();
try {
  const me = await client.getMe();
  console.log(
    JSON.stringify({ user_id: me.user_id, name: me.name, username: me.username, is_bot: me.is_bot }, null, 2),
  );
  if (me.username !== EXPECTED_USERNAME) {
    console.error(`Ожидался ник ${EXPECTED_USERNAME}, получен ${me.username}`);
    process.exitCode = 1;
  }
} finally {
  client.close();
}
