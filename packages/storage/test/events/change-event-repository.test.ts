// Интеграционные тесты ChangeEventRepository на PostgreSQL (PGlite): чтение = записанное,
// append идемпотентен по id, прочитанные события проходят схему change-event v1.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeEvent } from "@max-hackathon/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresChangeEventRepository } from "../../src/index.js";
import { contractValidator } from "../support/contracts.js";
import { createTestDatabase } from "../support/test-db.js";

const examples = join(import.meta.dirname, "../../../../contracts/v1/examples");
const read = (file: string) => JSON.parse(readFileSync(join(examples, file), "utf8")) as ChangeEvent;
const events = [
  read("change-event.rulepack-version.json"),
  read("change-event.regulation-document.json"),
  read("change-event.profile-change.json"),
];

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repository: PostgresChangeEventRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  repository = new PostgresChangeEventRepository(db);
});
afterEach(() => db.close());

describe("PostgresChangeEventRepository", () => {
  it("get возвращает ровно записанное событие каждого вида", async () => {
    for (const event of events) await repository.append(event);
    for (const event of events) expect(await repository.get(event.id)).toEqual(event);
  });

  it("неизвестное событие — undefined", async () => {
    expect(await repository.get("missing")).toBeUndefined();
  });

  it("append идемпотентен по id: повтор не дублирует и не меняет событие", async () => {
    const [event] = events as [ChangeEvent];
    await repository.append(event);
    await repository.append({ ...event, occurredAt: "2026-09-26T00:00:00Z" });
    expect(await repository.get(event.id)).toEqual(event);
    const { rows } = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM change_events");
    expect(rows[0]?.count).toBe(1);
  });

  it("событие profile_change индексируется по компании", async () => {
    for (const event of events) await repository.append(event);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM change_events WHERE company_id IS NOT NULL");
    expect(rows.map((row) => row.id)).toEqual(["event-profile-cafe-1"]);
  });

  it("прочитанные события проходят схему change-event v1", async () => {
    const validate = contractValidator("change-event");
    for (const event of events) {
      await repository.append(event);
      expect(validate(await repository.get(event.id)), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
