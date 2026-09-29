import { verifyInitData } from "@max-hackathon/security";
import { ChecklistService } from "@max-hackathon/services";
import {
  createPgClient,
  PostgresBotDialogRepository,
  PostgresNotificationSettingsRepository,
  PostgresProfileRepository,
  PostgresRequirementRepository,
} from "@max-hackathon/storage";
import { createMiniappApi } from "./api.js";
import { readConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { InMemorySessionStore } from "./session.js";

const config = readConfig(process.env);
const db = createPgClient(config.databaseUrl);
const dialogs = new PostgresBotDialogRepository(db);
const profiles = new PostgresProfileRepository(db);
const requirements = new PostgresRequirementRepository(db);
const settings = new PostgresNotificationSettingsRepository(db);
const checklist = new ChecklistService({ profiles, requirements });

const server = createHttpServer(
  createMiniappApi({
    botToken: config.botToken,
    sessions: new InMemorySessionStore(),
    verifyInitData,
    companyOf: (dialogId) => dialogs.companyOf(dialogId),
    profile: (companyId) => profiles.get(companyId),
    checklist: (companyId) => checklist.build(companyId),
    settingsFor: (companyId) => settings.settingsFor(companyId),
    saveSettings: (companyId, value) => settings.save(companyId, value),
  }),
);

server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`miniapp-api listening on ${config.port}\n`);
});

const shutdown = () => server.close(() => db.close().then(() => process.exit(0)));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
