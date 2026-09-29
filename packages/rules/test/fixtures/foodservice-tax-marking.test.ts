import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompanyProfile, Fact, FactValue, Requirement } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { assessRequirement } from "../../src/index.js";

const root = join(import.meta.dirname, "../../../..");
const pack = JSON.parse(
  readFileSync(join(root, "data/rulepacks/a/foodservice-tax-marking-federal-v1.json"), "utf8"),
) as { requirements: Requirement[] };
const byId = new Map(pack.requirements.map((requirement) => [requirement.id, requirement]));
const evaluatedAt = "2026-09-30T12:00:00Z";

const fact = (key: string, value: FactValue): Fact => ({
  id: `tax-marking.${key}`,
  companyId: "foodservice-test",
  key,
  value,
  kind: "declared",
  source: { system: "fixture", retrievedAt: evaluatedAt, isModel: true },
  observedAt: evaluatedAt,
});

const profile = (entityType: CompanyProfile["entityType"], extraFacts: Fact[] = []): CompanyProfile => ({
  contractVersion: 1,
  companyId: "foodservice-test",
  inn: entityType === "legal_entity" ? "7707083893" : "500100732259",
  entityType,
  facts: [fact("activity.okved_main", "56.10"), ...extraFacts],
  isModel: true,
  updatedAt: evaluatedAt,
});

const status = (id: string, company: CompanyProfile) =>
  assessRequirement(byId.get(id)!, company, { evaluatedAt }).status;

describe("пакет налогов и маркировки общепита", () => {
  it.each([
    ["a.fed.psn-application-payment", "psn"],
    ["a.fed.npd-receipts-tax", "npd"],
    ["a.fed.ip-fixed-contributions", "usn_income"],
  ] as const)("%s применяется только к ИП", (id, regime) => {
    const facts = [fact("tax.regime", regime), fact("employment.has_employees", false)];
    expect(status(id, profile("legal_entity", facts))).toBe("not_applies");
    expect(status(id, profile("individual_entrepreneur", facts))).toBe("needs_review");
  });

  it("правило о кегах учитывает продажу алкоголя, но оставляет проверку подключения кега", () => {
    const id = "a.fed.marking-beer-keg";
    expect(status(id, profile("legal_entity"))).toBe("insufficient_data");
    expect(status(id, profile("legal_entity", [fact("sales.alcohol", "none")]))).toBe("not_applies");
    expect(status(id, profile("legal_entity", [fact("sales.alcohol", "beer")]))).toBe("needs_review");
  });

  it.each(["a.fed.employer-6-ndfl", "a.fed.employer-rsv", "a.fed.employer-personal-data", "a.fed.employer-efs1"])(
    "%s не применяется к ИП без работников",
    (id) => {
      const noEmployees = [fact("employment.has_employees", false), fact("tax.regime", "usn_income")];
      const withEmployees = [fact("employment.has_employees", true), fact("tax.regime", "usn_income")];

      expect(status(id, profile("individual_entrepreneur", noEmployees))).toBe("not_applies");
      expect(status(id, profile("individual_entrepreneur", withEmployees))).toBe("needs_review");
      expect(status(id, profile("legal_entity", noEmployees))).toBe("needs_review");
    },
  );
});
