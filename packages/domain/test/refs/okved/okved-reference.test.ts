import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OkvedReference, parseOkvedCsv } from "../../../src/refs/okved/index.js";

const officialCsv = readFileSync(new URL("../../../../../data/refs/okved2-2026-08-01.csv", import.meta.url), "utf8");
const reference = new OkvedReference(parseOkvedCsv(officialCsv));

describe("OKVED2 reference", () => {
  it("finds 56.10 by the 56 prefix", () => {
    const matches = reference.searchByPrefix("56");

    expect(matches.some((entry) => entry.code === "56.10")).toBe(true);
    expect(matches.every((entry) => entry.code?.startsWith("56"))).toBe(true);
  });

  it("builds the hierarchy from section to detailed activity", () => {
    expect(reference.getByCode("56.10")?.parentId).toBe("code:56.1");
    expect(reference.childrenOf("56.1").map((entry) => entry.code)).toContain("56.10");
    expect(reference.ancestorsOf("56.10.21").map((entry) => entry.id)).toEqual([
      "code:56.10.2",
      "code:56.10",
      "code:56.1",
      "code:56",
      "section:I",
    ]);

    const knownIds = new Set(reference.entries.map((entry) => entry.id));
    expect(
      reference.entries
        .filter((entry) => entry.parentId !== null && !knownIds.has(entry.parentId))
        .map((entry) => entry.id),
    ).toEqual([]);
  });

  it("parses quoted delimiters and rejects malformed rows", () => {
    expect(parseOkvedCsv('I;"56";"Еда; напитки"\n')[0]?.name).toBe("Еда; напитки");
    expect(() => parseOkvedCsv('I;"56"\n')).toThrow("ожидалось 3 поля");
  });

  it("does not turn an empty query into an unbounded result", () => {
    expect(reference.searchByPrefix("  ")).toEqual([]);
    expect(() => reference.searchByPrefix("56..")).toThrow("Некорректный префикс");
  });
});
