// K-29: подготовленная версия в data/rulepacks/_demo совпадает с демо-изменением K-28 (k28-rulepack-v2),
// поэтому ожидаемый результат из data/fixtures/k28-expected.json верен и для демо-триггера.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_PACK_FILE, loadDemoPack, parseDemoPack } from "../../../src/flows/demo/index.js";

const ROOT = join(import.meta.dirname, "../../../../..");
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

describe("подготовленная версия модельного пакета", () => {
  it("модельная, следует за v1 и добавляет ровно k28.water-marking", async () => {
    const pack = await loadDemoPack(join(ROOT, DEMO_PACK_FILE));
    const v1 = json("data/fixtures/k28-rulepack-v1.json");

    expect(pack.packId).toBe(v1.packId);
    expect(pack.packVersion).toBe(v1.packVersion + 1);
    const before = new Set(v1.requirements.map((item: { id: string }) => item.id));
    expect(pack.requirements.map((item) => item.id).filter((id) => !before.has(id))).toEqual(["k28.water-marking"]);
  });

  it("совпадает с фикстурой K-28 v2", () => {
    expect(json(DEMO_PACK_FILE)).toEqual(json("data/fixtures/k28-rulepack-v2.json"));
  });

  it("отказывается публиковать немодельный пакет", () => {
    const pack = json(DEMO_PACK_FILE);
    expect(() => parseDemoPack({ ...pack, isModel: false })).toThrow("модельным");
    const [first, ...rest] = pack.requirements;
    expect(() =>
      parseDemoPack({ ...pack, requirements: [{ ...first, source: { ...first.source, isModel: false } }, ...rest] }),
    ).toThrow("модельным");
  });

  it("отказывается от первой версии: переход v0 → v1 уведомлений не даёт", () => {
    expect(() => parseDemoPack({ ...json(DEMO_PACK_FILE), packVersion: 1 })).toThrow("не меньше 2");
  });
});
