// #370: журнал поиска по реальному источнику и параметры реестра МСП для бота. Сеть не вызывается: ответы реестра
// подставляются модельным `fetch`, ИНН — модельный.
import { MspProfileSource } from "@max-hackathon/adapters";
import type { ProfileLookupResult, ProfileSource } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { type LookupLogger, loggedProfileSource, MSP_BOT_LOOKUP } from "../../src/app/profiles.js";

const MODEL_INN = "7700000016";

const recorder = () => {
  const entries: { level: "info" | "warn"; event: string; context: Record<string, unknown> }[] = [];
  const logger: LookupLogger = {
    info: (event, _message, context = {}) => entries.push({ level: "info", event, context: { ...context } }),
    warn: (event, _message, context = {}) => entries.push({ level: "warn", event, context: { ...context } }),
  };
  return { entries, logger };
};

const sourceOf = (answer: () => Promise<ProfileLookupResult>): ProfileSource => ({
  info: { name: "msp", isModel: false },
  lookupByInn: answer,
});

/** Часы, которые сдвигаются на `stepMs` при каждом чтении. */
const ticking = (stepMs: number) => {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
};

describe("loggedProfileSource", () => {
  it("недоступность: warn с кодом ошибки, признаком повтора и длительностью, без ИНН", async () => {
    const { entries, logger } = recorder();
    const source = loggedProfileSource(
      sourceOf(async () => ({ status: "unavailable", errorCode: "msp_network", retryable: true })),
      logger,
      ticking(1_000),
    );

    expect(await source.lookupByInn(MODEL_INN)).toEqual({
      status: "unavailable",
      errorCode: "msp_network",
      retryable: true,
    });
    expect(entries).toEqual([
      {
        level: "warn",
        event: "profile.lookup",
        context: { source: "msp", status: "unavailable", errorCode: "msp_network", retryable: true, durationMs: 1_000 },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(MODEL_INN);
  });

  it("найдено и не найдено: info со статусом, результат не меняется", async () => {
    const { entries, logger } = recorder();
    const source = loggedProfileSource(
      sourceOf(async () => ({ status: "not_found" })),
      logger,
      ticking(5),
    );

    expect(await source.lookupByInn(MODEL_INN)).toEqual({ status: "not_found" });
    expect(entries).toEqual([
      { level: "info", event: "profile.lookup", context: { source: "msp", status: "not_found", durationMs: 5 } },
    ]);
    expect(source.info).toEqual({ name: "msp", isModel: false });
  });

  it("исключение источника: warn и то же исключение дальше", async () => {
    const { entries, logger } = recorder();
    const failure = new TypeError("fetch failed");
    const source = loggedProfileSource(
      sourceOf(async () => {
        throw failure;
      }),
      logger,
      ticking(1),
    );

    await expect(source.lookupByInn(MODEL_INN)).rejects.toBe(failure);
    expect(entries).toEqual([
      {
        level: "warn",
        event: "profile.lookup",
        context: { source: "msp", status: "error", errorCode: "TypeError", durationMs: 1 },
      },
    ]);
  });
});

describe("MSP_BOT_LOOKUP", () => {
  it("худший случай ожидания ответа в чате — не больше 25 с", () => {
    const attempts = MSP_BOT_LOOKUP.retries + 1;
    const worstMs = attempts * MSP_BOT_LOOKUP.timeoutMs + MSP_BOT_LOOKUP.retries * MSP_BOT_LOOKUP.retryDelayMs;
    expect(worstMs).toBeLessThanOrEqual(25_000);
  });

  it("два обрыва подряд, третья попытка находит компанию", async () => {
    let calls = 0;
    const flaky: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
      return new Response(
        JSON.stringify({ data: [{ inn: MODEL_INN, is_active: 1, okved1: "56.10", regioncode: "77" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const source = new MspProfileSource({ ...MSP_BOT_LOOKUP, retryDelayMs: 0, fetch: flaky });

    const result = await source.lookupByInn(MODEL_INN);
    expect(result.status).toBe("found");
    expect(calls).toBe(3);
  });
});
