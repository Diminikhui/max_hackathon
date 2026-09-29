// K-12a. ЕГРЮЛ/ЕГРИП-`ProfileSource`: общий контракт на модельной выгрузке, разбор XML ФНС,
// понятная ошибка при недоступности. Контракт на реальных выгрузках — при заданных переменных
// `EGRUL_DATA_DIR`, `EGRUL_CONTRACT_KNOWN_INN`, `EGRUL_CONTRACT_UNKNOWN_INN` (иначе пропускается).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EGRUL_ERROR_CODES,
  EgrulProfileSource,
  latestByInn,
  loadEgrulDirectory,
  parseEgrulXml,
} from "../../../src/index.js";
import { parseXml } from "../../../src/profile/egrul/xml.js";
import { createProfileValidator, describeProfileSourceContract } from "../contract.js";

/** Модельная выгрузка в формате ФНС (windows-1251). Не ответы ФНС. */
const MODEL_DIR = join(import.meta.dirname, "model-dump");
const modelSource = () => new EgrulProfileSource({ load: () => loadEgrulDirectory(MODEL_DIR), isModel: true });

describeProfileSourceContract("egrul (модельная выгрузка, организация)", modelSource, {
  knownInn: "0000000018",
  unknownInn: "0000000040",
});

describeProfileSourceContract("egrul (модельная выгрузка, ИП)", modelSource, {
  knownInn: "000000000184",
  unknownInn: "000000000258",
});

const realDir = process.env["EGRUL_DATA_DIR"]?.trim();
const realKnown = process.env["EGRUL_CONTRACT_KNOWN_INN"]?.trim();
const realUnknown = process.env["EGRUL_CONTRACT_UNKNOWN_INN"]?.trim();
if (realDir && realKnown && realUnknown) {
  describeProfileSourceContract("egrul (реальные выгрузки ФНС)", () => EgrulProfileSource.fromEnv(), {
    knownInn: realKnown,
    unknownInn: realUnknown,
  });
} else {
  describe.skip("egrul (реальные выгрузки ФНС): задайте EGRUL_DATA_DIR и EGRUL_CONTRACT_*_INN", () => {
    it("пропущено", () => {});
  });
}

describe("EgrulProfileSource", () => {
  it("по умолчанию — реальный источник (не модельный)", () => {
    expect(new EgrulProfileSource().info).toEqual({ name: "egrul", isModel: false });
  });

  it("без выгрузок: понятная ошибка, а не пустой ответ", async () => {
    const result = await EgrulProfileSource.fromEnv({}).lookupByInn("0000000018");
    expect(result).toEqual({ status: "unavailable", errorCode: EGRUL_ERROR_CODES.notConfigured, retryable: false });
  });

  it("выгрузки не читаются: retryable-ошибка и повторная попытка загрузки", async () => {
    let calls = 0;
    const source = new EgrulProfileSource({
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error("нет доступа");
        return parseEgrulXml(`<EGRUL><СвЮЛ ИНН="0000000018" ОГРН="1" ДатаВып="2026-09-15"/></EGRUL>`);
      },
    });
    expect(await source.lookupByInn("0000000018")).toEqual({
      status: "unavailable",
      errorCode: EGRUL_ERROR_CODES.loadFailed,
      retryable: true,
    });
    expect(await source.lookupByInn("0000000018")).toMatchObject({ status: "found" });
  });

  it("несуществующий каталог → loadFailed", async () => {
    const source = EgrulProfileSource.fromEnv({ EGRUL_DATA_DIR: join(MODEL_DIR, "нет-такого") });
    expect(await source.lookupByInn("0000000018")).toMatchObject({ errorCode: EGRUL_ERROR_CODES.loadFailed });
  });

  it("организация: свежая запись, ОКВЭД без повторов, регион, краткое название, происхождение", async () => {
    const result = await modelSource().lookupByInn("0000000018");
    if (result.status !== "found") throw new Error(`ожидался found, получено ${result.status}`);
    const { profile } = result;
    expect(createProfileValidator()(profile)).toBe(true);
    expect(profile).toMatchObject({
      companyId: "egrul-0000000018",
      entityType: "legal_entity",
      displayName: 'ООО "МОДЕЛЬНАЯ КОФЕЙНЯ"',
      isModel: true,
      updatedAt: "2026-09-15T00:00:00Z",
    });
    const facts = Object.fromEntries(profile.facts.map((f) => [f.key, f]));
    expect(facts["activity.okved_main"]?.value).toBe("56.10");
    expect(facts["activity.okved_additional"]?.value).toEqual(["56.30"]);
    expect(facts["location.region_code"]?.value).toBe("77");
    expect(facts["activity.okved_main"]).toMatchObject({
      kind: "official",
      observedAt: "2026-09-15T00:00:00Z",
      source: {
        system: "egrul.nalog.ru",
        recordId: "1000000000001",
        retrievedAt: "2026-09-20T00:00:00Z",
        isModel: true,
      },
    });
  });

  it("адрес в формате ФИАС и дата ДД.ММ.ГГГГ", async () => {
    const result = await modelSource().lookupByInn("0000000025");
    if (result.status !== "found") throw new Error("ожидался found");
    expect(result.profile.facts.find((f) => f.key === "location.region_code")?.value).toBe("16");
    expect(result.profile.updatedAt).toBe("2026-09-15T00:00:00Z");
  });

  it("прекратившая деятельность организация → not_found", async () => {
    expect(await modelSource().lookupByInn("0000000032")).toEqual({ status: "not_found" });
  });

  it("ИП: без ФИО и региона (адрес проживания закрыт), только ОКВЭД", async () => {
    const result = await modelSource().lookupByInn("000000000184");
    if (result.status !== "found") throw new Error("ожидался found");
    expect(result.profile.entityType).toBe("individual_entrepreneur");
    expect(result.profile.displayName).toBeUndefined();
    expect(result.profile.facts.map((f) => f.key)).toEqual(["activity.okved_main"]);
  });
});

describe("parseEgrulXml", () => {
  it("не падает на числовой сущности вне диапазона Unicode", () => {
    expect(parseXml('<EGRUL hex="&#x110000;" decimal="&#99999999;"/>').attrs).toEqual({
      hex: "",
      decimal: "",
    });
  });

  it("отклоняет чужой корень и битый XML", () => {
    expect(() => parseEgrulXml("<Other/>")).toThrow(/EGRUL или EGRIP/);
    expect(() => parseEgrulXml("<EGRUL><СвЮЛ></EGRUL>")).toThrow(/XML/);
  });

  it("пропускает записи без ИНН, ОГРН или даты выписки", () => {
    const xml = `<EGRUL><СвЮЛ ИНН="0000000018" ОГРН="1"/><СвЮЛ ОГРН="2" ДатаВып="2026-01-01"/></EGRUL>`;
    expect(parseEgrulXml(xml)).toEqual([]);
  });

  it("latestByInn: более поздняя запись заменяет прежнюю целиком", () => {
    const records = parseEgrulXml(
      `<EGRUL>
        <СвЮЛ ИНН="0000000018" ОГРН="1" ДатаВып="2026-09-01"><СвАдресЮЛ><АдресРФ КодРегион="77"/></СвАдресЮЛ></СвЮЛ>
        <СвЮЛ ИНН="0000000018" ОГРН="1" ДатаВып="2026-09-10"/>
        <СвЮЛ ИНН="0000000018" ОГРН="1" ДатаВып="2026-08-01"/>
      </EGRUL>`,
    );
    const latest = latestByInn(records).get("0000000018");
    expect(latest?.statementDate).toBe("2026-09-10");
    expect(latest?.regionCode).toBeUndefined();
  });
});
