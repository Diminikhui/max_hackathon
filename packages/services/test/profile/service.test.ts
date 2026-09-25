// Тесты K-25b: сервис профиля на модельных данных K-28 (FixtureProfileSource) и подменных портах.
// Все ИНН вымышленные — из data/fixtures/k28-companies.json.
import { FixtureProfileSource } from "@max-hackathon/adapters";
import type { CompanyProfile, Fact, Requirement } from "@max-hackathon/domain";
import { assessRequirement } from "@max-hackathon/rules";
import { describe, expect, it } from "vitest";
import { INN_MESSAGES, PROFILE_MESSAGES, ProfileService } from "../../src/index.js";
import { InMemoryProfileRepository, StubProfileSource } from "./support/in-memory.js";

const NOW = "2026-09-25T10:00:00Z";
const LATER = "2026-09-26T10:00:00Z";
const CAFE_INN = "7700000016"; // k28-cafe-msk: ОКВЭД 56.10, 12 работников
const UNKNOWN_INN = "7700000048"; // валидная контрольная сумма, в K-28 нет

const setup = (options: { clock?: () => string } = {}) => {
  const repository = new InMemoryProfileRepository();
  const source = new FixtureProfileSource();
  const service = new ProfileService({ source, repository, clock: options.clock ?? (() => NOW) });
  return { repository, source, service };
};

const found = async (service: ProfileService, inn: string): Promise<CompanyProfile> => {
  const outcome = await service.lookup(inn);
  if (outcome.status !== "found") throw new Error(`ожидался found, получено ${outcome.status}`);
  return outcome.profile;
};

const factsByKey = (profile: CompanyProfile, key: string): Fact[] => profile.facts.filter((f) => f.key === key);

const requirement = (condition: Requirement["condition"]): Requirement => ({
  contractVersion: 1,
  id: "k25b-test",
  packId: "k25b-test-pack",
  packVersion: 1,
  kind: "obligation",
  title: "Модельная запись для теста",
  basis: [{ act: "Модельный акт", url: "https://example.invalid/act" }],
  condition,
  coverage: "full",
  source: { system: "fixture", retrievedAt: NOW, isModel: true },
});

describe("lookup: проверка ИНН (K-25a)", () => {
  it.each([
    ["", "empty"],
    ["77ООО00016", "invalid_characters"],
    ["770000001", "invalid_length"],
    ["7700000017", "invalid_checksum"],
  ])("«%s» → %s, источник не вызывается", async (input, code) => {
    const source = new StubProfileSource(() => ({ status: "not_found" }));
    const service = new ProfileService({ source, repository: new InMemoryProfileRepository() });
    const outcome = await service.lookup(input);
    expect(outcome.status).toBe("invalid_inn");
    if (outcome.status === "invalid_inn") {
      expect(outcome.error.code).toBe(code);
      expect(outcome.error.message.startsWith(INN_MESSAGES[outcome.error.code])).toBe(true);
    }
    expect(source.calls).toEqual([]);
  });

  it("нормализует ввод перед запросом к источнику", async () => {
    const { service } = setup();
    const outcome = await service.lookup(" ИНН 7700 0000 16 ");
    expect(outcome.status).toBe("found");
  });
});

describe("lookup: ответы источника", () => {
  it("found: модельный профиль K-28, ничего не сохраняет", async () => {
    const { service, repository } = setup();
    const outcome = await service.lookup(CAFE_INN);
    expect(outcome.status).toBe("found");
    if (outcome.status !== "found") return;
    expect(outcome.profile.companyId).toBe("k28-cafe-msk");
    expect(outcome.profile.isModel).toBe(true);
    expect(outcome.source).toEqual({ name: "fixture", isModel: true });
    expect(outcome.alreadySaved).toBe(false);
    expect(repository.saveCalls).toBe(0);
  });

  it("not_found: понятное сообщение, без исключения", async () => {
    const { service } = setup();
    expect(await service.lookup(UNKNOWN_INN)).toEqual({
      status: "not_found",
      inn: UNKNOWN_INN,
      message: PROFILE_MESSAGES.not_found,
    });
  });

  it("unavailable: код ошибки и признак повтора из источника", async () => {
    const source = new StubProfileSource(() => ({ status: "unavailable", errorCode: "timeout", retryable: true }));
    const service = new ProfileService({ source, repository: new InMemoryProfileRepository() });
    expect(await service.lookup(CAFE_INN)).toEqual({
      status: "unavailable",
      inn: CAFE_INN,
      errorCode: "timeout",
      retryable: true,
      message: PROFILE_MESSAGES.unavailable,
    });
  });

  it("исключение источника превращается в unavailable", async () => {
    const source = new StubProfileSource(() => {
      throw new Error("сеть");
    });
    const service = new ProfileService({ source, repository: new InMemoryProfileRepository() });
    const outcome = await service.lookup(CAFE_INN);
    expect(outcome).toMatchObject({ status: "unavailable", errorCode: "source_error", retryable: true });
  });
});

describe("confirm: сохранение профиля", () => {
  it("сохраняет профиль и возвращает companyId", async () => {
    const { service, repository } = setup();
    const profile = await found(service, CAFE_INN);
    const outcome = await service.confirm(profile);
    expect(outcome).toMatchObject({ status: "ok", companyId: "k28-cafe-msk", declared: [] });
    const saved = await repository.get("k28-cafe-msk");
    expect(saved?.facts).toEqual(profile.facts);
    expect(saved?.updatedAt).toBe(NOW);
  });

  it("правка при подтверждении сохраняется заявленной рядом с официальной", async () => {
    const { service, repository } = setup();
    const profile = await found(service, CAFE_INN);
    const outcome = await service.confirm(profile, [{ key: "activity.okved_main", value: "47.11" }]);
    expect(outcome.status).toBe("ok");
    const saved = await repository.get("k28-cafe-msk");
    const okved = factsByKey(saved as CompanyProfile, "activity.okved_main");
    expect(okved.map((f) => [f.kind, f.value])).toEqual([
      ["official", "56.10"],
      ["declared", "47.11"],
    ]);
    expect(okved[1]).toEqual({
      id: "k28-cafe-msk.declared.activity.okved_main",
      companyId: "k28-cafe-msk",
      key: "activity.okved_main",
      value: "47.11",
      kind: "declared",
      source: { system: "user", retrievedAt: NOW, isModel: true },
      observedAt: NOW,
    });
  });

  it("некорректная правка отклоняется без сохранения", async () => {
    const { service, repository } = setup();
    const profile = await found(service, CAFE_INN);
    const outcome = await service.confirm(profile, [{ key: "Bad Key", value: "x" }]);
    expect(outcome).toMatchObject({ status: "invalid_declaration", key: "Bad Key" });
    expect(repository.saveCalls).toBe(0);
  });
});

describe("declare: заявленный факт", () => {
  it("официальный факт того же ключа остаётся", async () => {
    const { service, repository } = setup();
    await service.confirm(await found(service, CAFE_INN));
    const outcome = await service.declare("k28-cafe-msk", "employment.headcount", 3);
    expect(outcome.status).toBe("ok");
    const saved = (await repository.get("k28-cafe-msk")) as CompanyProfile;
    expect(factsByKey(saved, "employment.headcount").map((f) => [f.kind, f.value])).toEqual([
      ["official", 12],
      ["declared", 3],
    ]);
  });

  it("повторное заявление того же ключа заменяет прежнее, дублей нет", async () => {
    let now = NOW;
    const { service, repository } = setup({ clock: () => now });
    await service.confirm(await found(service, CAFE_INN));
    await service.declare("k28-cafe-msk", "tax.regime", "osno");
    now = LATER;
    await service.declare("k28-cafe-msk", "tax.regime", "psn");
    const saved = (await repository.get("k28-cafe-msk")) as CompanyProfile;
    const declared = factsByKey(saved, "tax.regime").filter((f) => f.kind === "declared");
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({ value: "psn", observedAt: LATER });
    expect(factsByKey(saved, "tax.regime").some((f) => f.kind === "official" && f.value === "usn_income")).toBe(true);
  });

  it("новый ключ, которого нет у источника", async () => {
    const { service, repository } = setup();
    await service.confirm(await found(service, "1600000011")); // k28-cafe-kzn: нет tax.regime
    await service.declare("k28-cafe-kzn", "tax.regime", ["psn", "usn_income"]);
    const saved = (await repository.get("k28-cafe-kzn")) as CompanyProfile;
    expect(factsByKey(saved, "tax.regime")).toMatchObject([{ kind: "declared", value: ["psn", "usn_income"] }]);
  });

  it("ошибки: неизвестная компания, ключ, значение", async () => {
    const { service } = setup();
    expect(await service.declare("nope", "tax.regime", "osno")).toMatchObject({ status: "company_not_found" });
    await service.confirm(await found(service, CAFE_INN));
    expect(await service.declare("k28-cafe-msk", "tax", "osno")).toMatchObject({ status: "invalid_key" });
    expect(await service.declare("k28-cafe-msk", "employment.headcount", Number.NaN)).toMatchObject({
      status: "invalid_value",
    });
    expect(await service.declare("k28-cafe-msk", "sales.alcohol", null as unknown as string)).toMatchObject({
      status: "invalid_value",
    });
  });

  it("isModel заявленного факта берётся из профиля", async () => {
    const repository = new InMemoryProfileRepository();
    const real: CompanyProfile = {
      contractVersion: 1,
      companyId: "c-1",
      inn: CAFE_INN,
      entityType: "legal_entity",
      facts: [],
      isModel: false,
      updatedAt: NOW,
    };
    await repository.save(real);
    const service = new ProfileService({
      source: new StubProfileSource(() => ({ status: "not_found" })),
      repository,
      clock: () => NOW,
    });
    const outcome = await service.declare("c-1", "sales.alcohol", "none");
    expect(outcome.status === "ok" && outcome.fact.source.isModel).toBe(false);
  });
});

describe("повторный lookup сохранённой компании", () => {
  it("официальные факты обновляются из источника, заявленные пользователем остаются", async () => {
    const official = (value: string): CompanyProfile => ({
      contractVersion: 1,
      companyId: "src-id",
      inn: CAFE_INN,
      entityType: "legal_entity",
      facts: [
        {
          id: "src-id.okved",
          companyId: "src-id",
          key: "activity.okved_main",
          value,
          kind: "official",
          source: { system: "stub", retrievedAt: NOW, isModel: true },
          observedAt: NOW,
        },
      ],
      isModel: true,
      updatedAt: NOW,
    });
    let okved = "56.10";
    const source = new StubProfileSource(() => ({ status: "found", profile: official(okved) }));
    const repository = new InMemoryProfileRepository();
    const service = new ProfileService({ source, repository, clock: () => NOW });

    await service.confirm(await found(service, CAFE_INN));
    await service.declare("src-id", "sales.alcohol", "beer");

    okved = "56.30";
    const again = await service.lookup(CAFE_INN);
    expect(again).toMatchObject({ status: "found", alreadySaved: true });
    if (again.status !== "found") return;
    expect(again.profile.facts.map((f) => [f.key, f.kind, f.value])).toEqual([
      ["activity.okved_main", "official", "56.30"],
      ["sales.alcohol", "declared", "beer"],
    ]);

    const outcome = await service.confirm(again.profile);
    expect(outcome).toMatchObject({ status: "ok", companyId: "src-id" });
    const saved = (await repository.get("src-id")) as CompanyProfile;
    expect(saved.facts.map((f) => [f.key, f.kind, f.value])).toEqual([
      ["activity.okved_main", "official", "56.30"],
      ["sales.alcohol", "declared", "beer"],
    ]);
  });

  it("сохраняется прежний companyId, даже если источник выдал другой", async () => {
    const { service, repository } = setup();
    await service.confirm(await found(service, CAFE_INN));
    const fresh = await found(service, CAFE_INN);
    const outcome = await service.confirm({
      ...fresh,
      companyId: "other-id",
      facts: fresh.facts.map((f) => ({ ...f, companyId: "other-id" })),
    });
    expect(outcome).toMatchObject({ status: "ok", companyId: "k28-cafe-msk" });
    expect(await repository.listCompanyIds()).toEqual(["k28-cafe-msk"]);
    const saved = (await repository.get("k28-cafe-msk")) as CompanyProfile;
    expect(saved.facts.every((f) => f.companyId === "k28-cafe-msk")).toBe(true);
  });
});

describe("вычислитель по-прежнему берёт официальный факт", () => {
  it("заявленный ОКВЭД не меняет статус записи по официальному", async () => {
    const { service, repository } = setup();
    await service.confirm(await found(service, CAFE_INN));
    await service.declare("k28-cafe-msk", "activity.okved_main", "47.11");
    const saved = (await repository.get("k28-cafe-msk")) as CompanyProfile;

    const result = assessRequirement(requirement({ type: "okved_prefix", prefix: "56" }), saved, {
      evaluatedAt: NOW,
    });
    expect(result.status).toBe("applies");
    expect(result.trace?.factIds).toEqual(["k28-cafe-msk.okved"]);

    const other = assessRequirement(requirement({ type: "okved_prefix", prefix: "47" }), saved, {
      evaluatedAt: NOW,
    });
    expect(other.status).toBe("not_applies");
  });

  it("заявленный факт используется, когда официального нет", async () => {
    const { service, repository } = setup();
    await service.confirm(await found(service, "1600000011")); // нет tax.regime
    await service.declare("k28-cafe-kzn", "tax.regime", "psn");
    const saved = (await repository.get("k28-cafe-kzn")) as CompanyProfile;
    const result = assessRequirement(requirement({ type: "tax_regime", in: ["psn"] }), saved, { evaluatedAt: NOW });
    expect(result.status).toBe("applies");
    expect(result.trace?.factIds).toEqual(["k28-cafe-kzn.declared.tax.regime"]);
  });
});
