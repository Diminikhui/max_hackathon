import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChecklist } from "./api";
import { MODEL_CHECKLIST } from "./model";
import { filterChecklist, STATUS_META, sourceUrl } from "./status";
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
