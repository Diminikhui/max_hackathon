import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRegionsCsv, RegionReference } from "../../../src/refs/regions/index.js";

const officialExtract = readFileSync(
  new URL("../../../../../data/refs/regions-ssrf-2025-10-01.csv", import.meta.url),
  "utf8",
);
const reference = new RegionReference(parseRegionsCsv(officialExtract));

describe("FTS subject reference", () => {
  it("contains Moscow and the Republic of Tatarstan under their official codes", () => {
    expect(reference.entries).toEqual([
      { code: "16", name: "Республика Татарстан (Татарстан)" },
      { code: "77", name: "город Москва" },
    ]);
    expect(reference.getByCode("16")?.name).toBe("Республика Татарстан (Татарстан)");
    expect(reference.getByCode(" 77 ")?.name).toBe("город Москва");
  });

  it("parses quoted delimiters and rejects malformed records", () => {
    expect(parseRegionsCsv('16;"Республика; Татарстан"\n')[0]?.name).toBe("Республика; Татарстан");
    expect(() => parseRegionsCsv("7;Москва\n")).toThrow("Некорректный код региона");
    expect(() => parseRegionsCsv("77;\n")).toThrow("Некорректное наименование региона");
    expect(() => parseRegionsCsv("77\n")).toThrow("ожидалось 2 поля");
  });

  it("rejects duplicate subject codes", () => {
    expect(
      () =>
        new RegionReference([
          { code: "77", name: "город Москва" },
          { code: "77", name: "дубликат" },
        ]),
    ).toThrow("Повторяющийся код региона: 77");
  });
});
