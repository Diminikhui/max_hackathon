import type { Requirement } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { FixtureRequirementSource, MODEL_REQUIREMENTS } from "../../src/requirements/index.js";
import { describeRequirementSourceContract } from "./contract.js";

describeRequirementSourceContract("fixture", () => new FixtureRequirementSource(), {
  query: { okvedPrefixes: ["56.10"], regionCodes: ["16"] },
  expectAtLeast: 3,
});

describe("FixtureRequirementSource", () => {
  it("работает без сети и возвращает весь модельный набор без фильтра", async () => {
    expect(await new FixtureRequirementSource().listRequirements({})).toHaveLength(MODEL_REQUIREMENTS.length);
  });

  it("фильтрует по пересекающимся префиксам ОКВЭД", async () => {
    const source = new FixtureRequirementSource();
    const foodservice = await source.listRequirements({ okvedPrefixes: ["56.10"] });
    expect(foodservice.map(({ id }) => id)).toEqual([
      "k13a.model.foodservice.base",
      "k13a.model.foodservice.employees",
      "k13a.model.foodservice.tatarstan",
    ]);
    expect(await source.listRequirements({ okvedPrefixes: ["45.2"] })).toEqual([]);
  });

  it("оставляет федеральные записи и исключает чужие региональные", async () => {
    const source = new FixtureRequirementSource();
    const moscow = await source.listRequirements({ okvedPrefixes: ["56"], regionCodes: ["77"] });
    expect(moscow.map(({ id }) => id)).toEqual(["k13a.model.foodservice.base", "k13a.model.foodservice.employees"]);
  });

  it("отклоняет немодельные и дублирующиеся записи", () => {
    const model = structuredClone(MODEL_REQUIREMENTS[0]) as Requirement;
    expect(() => new FixtureRequirementSource([{ ...model, source: { ...model.source, isModel: false } }])).toThrow(
      "не помечено модельным",
    );
    expect(() => new FixtureRequirementSource([model, structuredClone(model)])).toThrow("встречается в fixture дважды");
  });
});
