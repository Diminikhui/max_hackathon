import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChecklist } from "./api";
import { MODEL_CHECKLIST } from "./model";
import { filterChecklist, requirementDetails, STATUS_META, sourceUrl, visibleStatusFilters } from "./status";
import { CHECKLIST_STATUSES } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("checklist screen model", () => {
  it("shows and filters all five statuses", () => {
    expect(Object.keys(STATUS_META)).toEqual(CHECKLIST_STATUSES);
    for (const status of CHECKLIST_STATUSES) {
      const filtered = filterChecklist(MODEL_CHECKLIST.items, status);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.applicability.status).toBe(status);
    }
  });

  it("uses the legal basis as the primary source link", () => {
    const first = MODEL_CHECKLIST.items[0];
    expect(first).toBeDefined();
    if (first) expect(sourceUrl(first)).toBe("https://publication.pravo.gov.ru/");
  });
});

describe("открытая карточка (#372)", () => {
  const item = MODEL_CHECKLIST.items[0];
  if (!item) throw new Error("в модельном перечне нет записей");

  it("подписанные блоки в порядке чтения; срок целиком; основание — акт и статья с неразрывным «№»", () => {
    const details = requirementDetails({
      ...item,
      requirement: {
        ...item.requirement,
        deadline: "Начало — до фактического начала работы по адресу; смена адреса — в день изменения",
        basis: [
          {
            act: "Федеральный закон от 26.12.2008 № 294-ФЗ",
            article: "ст. 8",
            url: "https://publication.pravo.gov.ru/",
          },
          { act: "Модельное основание без статьи", url: "https://publication.pravo.gov.ru/" },
        ],
      },
    });

    expect(details.map((block) => block.label)).toEqual([
      "Суть требования",
      "Срок",
      "Почему такой статус",
      "Основание",
    ]);
    expect(details[1]?.lines).toEqual([
      "Начало — до фактического начала работы по адресу; смена адреса — в день изменения",
    ]);
    expect(details[3]?.lines).toEqual([
      "Федеральный закон от 26.12.2008 №\u00a0294-ФЗ, ст. 8",
      "Модельное основание без статьи",
    ]);
  });

  it("пустые блоки не выводятся", () => {
    const details = requirementDetails({
      requirement: { ...item.requirement, summary: undefined, deadline: undefined, basis: [] },
      applicability: { ...item.applicability, statusReason: undefined },
    });
    expect(details).toEqual([]);
  });

  it("фильтры только для статусов, в которых есть записи, в прежнем порядке", () => {
    expect(
      visibleStatusFilters({
        applies: 14,
        not_applies: 15,
        insufficient_data: 0,
        needs_review: 26,
        out_of_coverage: 1,
      }),
    ).toEqual(["applies", "not_applies", "needs_review", "out_of_coverage"]);
  });
});

describe("fetchChecklist", () => {
  it("creates a session from initData and requests the session checklist", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "model_session_token_1234567890" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(MODEL_CHECKLIST), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchChecklist("signed-model-init-data")).resolves.toEqual(MODEL_CHECKLIST);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/session",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ initData: "signed-model-init-data" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/checklist",
      expect.objectContaining({ headers: { authorization: "Bearer model_session_token_1234567890" } }),
    );
  });
});
