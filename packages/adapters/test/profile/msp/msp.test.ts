// K-12b. `MspProfileSource`: общий контракт на записанном ответе реестра МСП и поведение адаптера.
// Все ИНН вымышленные; живой запрос — только при заданном MSP_LIVE_INN (см. README адаптера).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MspProfileSource, type MspRecord, mapMspRecord } from "../../../src/index.js";
import { createProfileValidator, describeProfileSourceContract } from "../contract.js";

const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "recorded-response.json"), "utf8")) as {
  data: MspRecord[];
};
const NOW = new Date("2026-09-27T17:31:41Z");

/** Отвечает записанным ответом, отфильтрованным по подстроке запроса — как быстрый поиск ФНС. */
function recordedFetch(calls: string[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const query = new URLSearchParams(String(init?.body)).get("query") ?? "";
    calls.push(query);
    const data = recorded.data.filter((row) => row.inn.includes(query));
    return new Response(JSON.stringify({ ...recorded, data, rowCount: data.length }), { status: 200 });
  }) as typeof fetch;
}

const source = (fetchImpl: typeof fetch = recordedFetch()) =>
  new MspProfileSource({ fetch: fetchImpl, now: () => NOW, retries: 0 });

describeProfileSourceContract("msp (записанный ответ)", () => source(), {
  knownInn: "7700000016",
  unknownInn: "7700000047",
});

describe("MspProfileSource", () => {
  it("реальный источник, не модельный", () => {
    expect(source().info).toEqual({ name: "msp", isModel: false });
  });

  it("переносит ОКВЭД, регион, категорию, численность и лицензии", async () => {
    const result = await source().lookupByInn("7700000016");
    if (result.status !== "found") throw new Error(result.status);
    const facts = Object.fromEntries(result.profile.facts.map((f) => [f.key, f]));
    expect(facts["activity.okved_main"]?.value).toBe("56.10");
    expect(facts["location.region_code"]?.value).toBe("77");
    expect(facts["scale.msp_category"]?.value).toBe("micro");
    expect(facts["employment.headcount"]?.value).toBe(21);
    expect(facts["employment.has_employees"]).toMatchObject({
      value: true,
      kind: "derived",
      derivedFrom: ["msp-7700000016.headcount"],
    });
    expect(facts["licenses.has_any"]?.value).toBe(false);
    expect(facts["activity.okved_main"]?.source).toMatchObject({
      system: "rmsp.nalog.ru",
      isModel: false,
      retrievedAt: NOW.toISOString(),
    });
    expect(result.profile.isModel).toBe(false);
  });

  it("берёт только точное совпадение ИНН, а не подстроку", async () => {
    const result = await source().lookupByInn("7700000016");
    expect(result).toMatchObject({ status: "found", profile: { inn: "7700000016" } });
  });

  it("исключённая из реестра компания → not_found", async () => {
    expect(await source().lookupByInn("7700000023")).toEqual({ status: "not_found" });
  });

  it("некорректный ИНН не уходит в сеть", async () => {
    const calls: string[] = [];
    await source(recordedFetch(calls)).lookupByInn("abc");
    expect(calls).toEqual([]);
  });

  it("численность 0 или её отсутствие не даёт has_employees", () => {
    const base = recorded.data[0] as MspRecord;
    const zero = mapMspRecord({ ...base, od2_sschr: 0 }, NOW);
    expect(zero.facts.find((f) => f.key === "employment.headcount")?.value).toBe(0);
    expect(zero.facts.some((f) => f.key === "employment.has_employees")).toBe(false);
    const { od2_sschr: _omit, ...noHeadcount } = base;
    const none = mapMspRecord(noHeadcount, NOW);
    expect(none.facts.some((f) => f.key.startsWith("employment."))).toBe(false);
  });

  it("ИП, категория вне 1–3 и пустые поля: факты без значений не создаются, схема соблюдена", () => {
    const profile = mapMspRecord({ inn: "770000000082", category: 0, regioncode: "5", okved1: " ", nptype: "IP" }, NOW);
    expect(profile.entityType).toBe("individual_entrepreneur");
    expect(profile.facts.map((f) => f.key)).toEqual(["location.region_code"]);
    expect(profile.facts[0]?.value).toBe("05");
    expect(profile.displayName).toBeUndefined();
    const validate = createProfileValidator();
    expect(validate(profile), JSON.stringify(validate.errors)).toBe(true);
  });

  it("ошибки источника → unavailable с признаком повтора", async () => {
    const status = (code: number) => (async () => new Response("", { status: code })) as unknown as typeof fetch;
    expect(await source(status(503)).lookupByInn("7700000016")).toEqual({
      status: "unavailable",
      errorCode: "msp_http_503",
      retryable: true,
    });
    expect(await source(status(403)).lookupByInn("7700000016")).toEqual({
      status: "unavailable",
      errorCode: "msp_http_403",
      retryable: false,
    });

    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await source(html).lookupByInn("7700000016")).toEqual({
      status: "unavailable",
      errorCode: "msp_bad_response",
      retryable: true,
    });

    const noData = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await source(noData).lookupByInn("7700000016")).toMatchObject({
      status: "unavailable",
      errorCode: "msp_bad_response",
    });

    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await source(offline).lookupByInn("7700000016")).toEqual({
      status: "unavailable",
      errorCode: "msp_network",
      retryable: true,
    });
  });

  it("временная ошибка повторяется, постоянная — нет", async () => {
    let calls = 0;
    const flaky = (async (url: unknown, init?: RequestInit) => {
      calls++;
      return calls === 1 ? new Response("", { status: 502 }) : recordedFetch()(url as string, init);
    }) as typeof fetch;
    const retrying = new MspProfileSource({ fetch: flaky, now: () => NOW, retryDelayMs: 1 });
    expect(await retrying.lookupByInn("7700000016")).toMatchObject({ status: "found" });
    expect(calls).toBe(2);

    let denied = 0;
    const forbidden = (async () => {
      denied++;
      return new Response("", { status: 403 });
    }) as unknown as typeof fetch;
    await new MspProfileSource({ fetch: forbidden, retryDelayMs: 1, retries: 3 }).lookupByInn("7700000016");
    expect(denied).toBe(1);
  });

  it("зависший ответ обрывается по таймауту", async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const result = await new MspProfileSource({ fetch: hang, timeoutMs: 20, retries: 0 }).lookupByInn("7700000016");
    expect(result).toEqual({ status: "unavailable", errorCode: "msp_timeout", retryable: true });
  });
});

// Живая проверка на реальном ответе ФНС. ИНН берётся из окружения и не попадает в репозиторий.
const liveInn = process.env.MSP_LIVE_INN;
describe.runIf(Boolean(liveInn))("MspProfileSource (живой запрос, MSP_LIVE_INN)", () => {
  describeProfileSourceContract("msp (живой)", () => new MspProfileSource({ timeoutMs: 60_000 }), {
    knownInn: liveInn ?? "",
    unknownInn: "7700000047",
  });
});
