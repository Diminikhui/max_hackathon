// Интеграционные тесты хранения состояния бота (#312) на PostgreSQL (PGlite): диалог, привязка к компании,
// пропущенные вопросы, справочник «чат → компания» и настройки уведомлений. Компании и чаты модельные.
import { beforeEach, describe, expect, it } from "vitest";
import {
  PostgresBotDialogRepository,
  PostgresChatDirectoryRepository,
  PostgresClarifySkipRepository,
  PostgresNotificationSettingsRepository,
} from "../../src/index.js";
import { type TestDatabase, useSharedTestDatabase } from "../support/test-db.js";

const DIALOG = "chat-model-1";
const testDatabase = useSharedTestDatabase();
let db: TestDatabase;

beforeEach(() => {
  db = testDatabase();
});

describe("PostgresBotDialogRepository", () => {
  it("неизвестный диалог — пустой", async () => {
    const dialogs = new PostgresBotDialogRepository(db);
    expect(await dialogs.stateOf(DIALOG)).toBeUndefined();
    expect(await dialogs.companyOf(DIALOG)).toBeUndefined();
    expect(await dialogs.pendingProfile(DIALOG)).toBeUndefined();
  });

  it("состояние, профиль в ожидании и привязка хранятся независимо", async () => {
    const dialogs = new PostgresBotDialogRepository<{ profile: { inn: string }; alreadySaved: boolean }>(db);
    await dialogs.saveState(DIALOG, "confirming_profile");
    await dialogs.setPendingProfile(DIALOG, { profile: { inn: "7700000016" }, alreadySaved: false });
    await dialogs.bindCompany(DIALOG, "company:a");

    const fresh = new PostgresBotDialogRepository(db);
    expect(await fresh.stateOf(DIALOG)).toBe("confirming_profile");
    expect(await fresh.pendingProfile(DIALOG)).toEqual({ profile: { inn: "7700000016" }, alreadySaved: false });
    expect(await fresh.companyOf(DIALOG)).toBe("company:a");

    await dialogs.setPendingProfile(DIALOG, undefined);
    expect(await fresh.pendingProfile(DIALOG)).toBeUndefined();
    expect(await fresh.stateOf(DIALOG)).toBe("confirming_profile");
  });

  it("повторная привязка того же диалога заменяет компанию (смена компании, #310)", async () => {
    const dialogs = new PostgresBotDialogRepository(db);
    await dialogs.bindCompany(DIALOG, "company:a");
    await dialogs.bindCompany(DIALOG, "company:b");
    expect(await dialogs.companyOf(DIALOG)).toBe("company:b");
  });
});

describe("PostgresClarifySkipRepository", () => {
  it("хранит пропущенные ключи и очищает их пустым списком", async () => {
    const skips = new PostgresClarifySkipRepository(db);
    expect(await skips.get(DIALOG)).toEqual([]);
    await skips.set(DIALOG, ["has_employees", "sells_alcohol"]);
    expect(await new PostgresClarifySkipRepository(db).get(DIALOG)).toEqual(["has_employees", "sells_alcohol"]);
    await skips.set(DIALOG, []);
    expect(await skips.get(DIALOG)).toEqual([]);
  });

  it("не затирает привязку диалога", async () => {
    const dialogs = new PostgresBotDialogRepository(db);
    await dialogs.bindCompany(DIALOG, "company:a");
    await new PostgresClarifySkipRepository(db).set(DIALOG, ["has_employees"]);
    expect(await dialogs.companyOf(DIALOG)).toBe("company:a");
  });
});

describe("PostgresChatDirectoryRepository", () => {
  it("чат компании — последний, где её выбрали; снятие привязки возвращает прежний", async () => {
    const directory = new PostgresChatDirectoryRepository(db);
    await directory.track("chat-1", "company:a");
    await directory.track("chat-2", "company:a");
    expect(await directory.chatFor("company:a")).toBe("chat-2");

    await directory.track("chat-1", "company:a");
    expect(await directory.chatFor("company:a")).toBe("chat-1");

    await directory.track("chat-1", "company:b");
    expect(await directory.chatFor("company:a")).toBe("chat-2");
    expect(await directory.chatFor("company:b")).toBe("chat-1");

    await directory.track("chat-2", undefined);
    expect(await directory.chatFor("company:a")).toBeUndefined();
  });
});

describe("PostgresNotificationSettingsRepository", () => {
  it("нет записи — undefined; сохранение заменяет прежние настройки", async () => {
    const settings = new PostgresNotificationSettingsRepository(db);
    expect(await settings.settingsFor("company:a")).toBeUndefined();
    await settings.save("company:a", { enabled: false, earlySignals: true });
    await settings.save("company:a", { enabled: false, earlySignals: false });
    expect(await new PostgresNotificationSettingsRepository(db).settingsFor("company:a")).toEqual({
      enabled: false,
      earlySignals: false,
    });
  });
});
