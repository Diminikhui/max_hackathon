// K-11. Fixture-`ProfileSource` на модельных компаниях K-28: общий контракт и поведение fixture.
import type { CompanyProfile } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { FixtureProfileSource, loadFixtureProfiles } from "../../src/index.js";
import { describeProfileSourceContract } from "./contract.js";

const k28 = loadFixtureProfiles();

describeProfileSourceContract("fixture (K-28, организация)", () => new FixtureProfileSource(), {
  knownInn: "7700000016",
  unknownInn: "7700000047",
});

describeProfileSourceContract("fixture (K-28, ИП)", () => new FixtureProfileSource(), {
  knownInn: "770000000082",
  unknownInn: "770000000099",
});

describe("FixtureProfileSource", () => {
  it("помечен модельным", () => {
    expect(new FixtureProfileSource().info).toEqual({ name: "fixture", isModel: true });
  });

  it("по умолчанию отдаёт все 5 модельных компаний K-28", async () => {
    const source = new FixtureProfileSource();
    expect(k28).toHaveLength(5);
    for (const company of k28) {
      expect(await source.lookupByInn(company.inn)).toEqual({ status: "found", profile: company });
    }
  });

  it("принимает переданный список профилей", async () => {
    const [first, second] = k28 as [CompanyProfile, CompanyProfile];
    const source = new FixtureProfileSource([second]);
    expect(await source.lookupByInn(second.inn)).toMatchObject({ status: "found", profile: { inn: second.inn } });
    expect(await source.lookupByInn(first.inn)).toEqual({ status: "not_found" });
    expect(await new FixtureProfileSource([]).lookupByInn(first.inn)).toEqual({ status: "not_found" });
  });

  it("убирает пробелы вокруг ИНН", async () => {
    const result = await new FixtureProfileSource().lookupByInn(" 7700000016\n");
    expect(result).toMatchObject({ status: "found", profile: { companyId: "k28-cafe-msk" } });
  });

  it("возвращает копию: изменение результата не портит фикстуру", async () => {
    const source = new FixtureProfileSource();
    const first = await source.lookupByInn("7700000016");
    if (first.status !== "found") throw new Error("ожидался found");
    first.profile.facts.length = 0;
    first.profile.displayName = "изменено";
    const second = await source.lookupByInn("7700000016");
    if (second.status !== "found") throw new Error("ожидался found");
    expect(second.profile.facts.length).toBeGreaterThan(0);
    expect(second.profile.displayName).not.toBe("изменено");
  });

  it("не принимает профили без пометки модельных", () => {
    const real = { ...(k28[0] as CompanyProfile), isModel: false };
    expect(() => new FixtureProfileSource([real])).toThrow(/модельным/);
  });

  it("не принимает повторяющиеся ИНН", () => {
    const profile = k28[0] as CompanyProfile;
    expect(() => new FixtureProfileSource([profile, { ...profile, companyId: "dup" }])).toThrow(/дважды/);
  });
});
