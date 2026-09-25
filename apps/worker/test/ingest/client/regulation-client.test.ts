// Клиент regulation.gov.ru на модельных ответах: форма ответов портала не подтверждена живым запросом,
// все XML и JSON ниже — модельные данные.
import { describe, expect, it } from "vitest";
import {
  buildFilter,
  type FetchLike,
  pageFromJson,
  parseRetryAfter,
  parseXml,
  RegulationClient,
  RegulationClientError,
  XmlParseError,
} from "../../../src/ingest/client/index.js";

const MODEL_NPALIST = `<?xml version="1.0" encoding="utf-8"?>
<!-- модельные данные -->
<npalist>
  <npa id="900001">
    <title><![CDATA[Об изменении Правил оказания услуг общественного питания <модель>]]></title>
    <department>Модельное ведомство</department>
    <publishDate>2026-09-01</publishDate>
    <okveds><okved id="23"/><okved>45</okved></okveds>
  </npa>
  <npa>
    <id>900002</id>
    <title>  Требования к  автосервисам &amp; СТО  </title>
    <department></department>
    <stage/>
  </npa>
  <npa><title>Запись без идентификатора</title></npa>
  <npa id="  "/>
</npalist>`;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function modelFetch(responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("лишний запрос");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parseXml", () => {
  it("разбирает атрибуты, CDATA, сущности и самозакрытые теги", () => {
    const root = parseXml(MODEL_NPALIST);
    expect(root.name).toBe("npalist");
    expect(root.children).toHaveLength(4);
    expect(root.children[0]?.children[0]?.text).toContain("<модель>");
    expect(root.children[1]?.children[1]?.text).toBe("Требования к  автосервисам & СТО");
  });

  it("отвергает битый документ и DTD", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(XmlParseError);
    expect(() => parseXml("<a>")).toThrow(XmlParseError);
    expect(() => parseXml("")).toThrow(XmlParseError);
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')).toThrow(XmlParseError);
  });
});

describe("listNpa", () => {
  it("забирает выборку, пропуская записи без идентификатора и не падая на пустых полях", async () => {
    const { fetch, calls } = modelFetch([new Response(MODEL_NPALIST)]);
    const client = new RegulationClient({ fetch, ...fakeClock() });
    const page = await client.listNpa({ limit: 500 });

    expect(calls[0]?.url).toBe("https://regulation.gov.ru/api/npalist/?limit=500");
    expect(page.skipped).toBe(2);
    expect(page.items).toEqual([
      {
        id: "900001",
        url: "https://regulation.gov.ru/projects/900001",
        title: "Об изменении Правил оказания услуг общественного питания <модель>",
        department: "Модельное ведомство",
        publishedAt: "2026-09-01",
        sphereIds: [23, 45],
      },
      {
        id: "900002",
        url: "https://regulation.gov.ru/projects/900002",
        title: "Требования к автосервисам & СТО",
        sphereIds: [],
      },
    ]);
  });

  it("пустой список — пустая выборка; битый XML — ошибка источника", async () => {
    const empty = new RegulationClient({ fetch: modelFetch([new Response("<npalist/>")]).fetch });
    expect(await empty.listNpa()).toEqual({ items: [], skipped: 0 });

    const broken = new RegulationClient({ fetch: modelFetch([new Response("<html><body>")]).fetch, maxRetries: 0 });
    await expect(broken.listNpa()).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("отклоняет limit больше 500", async () => {
    const client = new RegulationClient({ fetch: modelFetch([]).fetch });
    await expect(client.listNpa({ limit: 501 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("GetFiltered", () => {
  it("строит фильтр по сферам и заголовку с экранированием", () => {
    expect(buildFilter({ sphereIds: [23, 45, 23], titleContains: " кафе, бары|рестораны " })).toBe(
      "okveds==23|45,title@=кафе\\, бары\\|рестораны",
    );
    expect(buildFilter({})).toBe("");
    expect(() => buildFilter({ sphereIds: [0] })).toThrow(RegulationClientError);
  });

  it("разбирает неполные и странные записи", () => {
    const page = pageFromJson({
      items: [
        { Id: 1, Title: "Модельный проект", okveds: [{ id: 23 }, "45", null, "x"], department: { name: "Ведомство" } },
        { id: null, title: "без id" },
        "мусор",
        { id: "2", title: null, okveds: null },
      ],
      totalCount: 4,
    });
    expect(page.total).toBe(4);
    expect(page.received).toBe(4);
    expect(page.skipped).toBe(2);
    expect(page.items.map((i) => [i.id, i.title, i.department, i.sphereIds])).toEqual([
      ["1", "Модельный проект", "Ведомство", [23, 45]],
      ["2", undefined, undefined, []],
    ]);
    expect(pageFromJson(null)).toMatchObject({ items: [], skipped: 0, total: undefined });
  });

  it("листает страницы по 500 до неполной страницы и убирает дубли", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, title: `Проект ${i + 1}` }));
    const tail = [{ id: 500, title: "дубль" }, { id: 501 }];
    const { fetch, calls } = modelFetch([json({ items: full }), json({ items: tail })]);
    const clock = fakeClock();
    const client = new RegulationClient({ fetch, ...clock, minIntervalMs: 1000 });

    const result = await client.getFiltered({ sphereIds: [23] });
    expect(result.pages).toBe(2);
    expect(result.items).toHaveLength(501);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      filters: "okveds==23",
      sorts: "-id",
      page: 2,
      pageSize: 500,
    });
    expect(clock.sleeps).toEqual([1000]);
  });

  it("останавливается по total и по maxPages", async () => {
    const two = [{ id: 1 }, { id: 2 }];
    const byTotal = new RegulationClient({ fetch: modelFetch([json({ items: two, total: 2 })]).fetch });
    expect((await byTotal.getFiltered({ pageSize: 2 })).pages).toBe(1);

    const endless = modelFetch([json(two), json([{ id: 3 }, { id: 4 }])]);
    const capped = new RegulationClient({ fetch: endless.fetch, minIntervalMs: 0 });
    const result = await capped.getFiltered({ pageSize: 2, maxPages: 2 });
    expect(result.items.map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
    expect(endless.calls).toHaveLength(2);
  });

  it("пустое тело и не-JSON", async () => {
    const empty = new RegulationClient({ fetch: modelFetch([new Response("")]).fetch });
    expect((await empty.getFiltered({})).items).toEqual([]);
    const html = new RegulationClient({ fetch: modelFetch([new Response("<html>")]).fetch });
    await expect(html.getFiltered({})).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
});

describe("ошибки и повторы", () => {
  it("повторяет 429 с учётом Retry-After и 503 с растущей задержкой", async () => {
    const { fetch, calls } = modelFetch([
      new Response("", { status: 429, headers: { "Retry-After": "7" } }),
      new Response("", { status: 503 }),
      new Response("<npalist/>"),
    ]);
    const clock = fakeClock();
    const client = new RegulationClient({ fetch, ...clock, minIntervalMs: 0, retryBaseMs: 1000 });
    await client.listNpa();
    expect(calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([7000, 2000]);
  });

  it("сдаётся после maxRetries и не повторяет ошибки запроса", async () => {
    const down = modelFetch([new Response("", { status: 502 }), new Response("", { status: 502 })]);
    const client = new RegulationClient({ fetch: down.fetch, ...fakeClock(), maxRetries: 1 });
    await expect(client.listNpa()).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 502 });
    expect(down.calls).toHaveLength(2);

    const bad = modelFetch([new Response("", { status: 400 })]);
    const client400 = new RegulationClient({ fetch: bad.fetch, ...fakeClock() });
    await expect(client400.listNpa()).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
    expect(bad.calls).toHaveLength(1);
  });

  it("сетевые сбои и таймауты — временные ошибки", async () => {
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const net = new RegulationClient({ fetch: modelFetch([new TypeError("fetch failed")]).fetch, maxRetries: 0 });
    await expect(net.listNpa()).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: true });
    const slow = new RegulationClient({ fetch: modelFetch([timeout]).fetch, maxRetries: 0 });
    await expect(slow.listNpa()).rejects.toMatchObject({ code: "DEPENDENCY_TIMEOUT" });
  });

  it("parseRetryAfter понимает секунды и дату", () => {
    expect(parseRetryAfter("3", 0)).toBe(3000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 4000)).toBe(6000);
    expect(parseRetryAfter("чушь", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});
