import type { CompanyProfile } from "@max-hackathon/domain";
import { verifyInitData } from "@max-hackathon/security";
import type { ChecklistOutcome } from "@max-hackathon/services";
import { describe, expect, it, vi } from "vitest";
import { createMiniappApi, type MiniappApiDeps } from "../src/api.js";
import { InMemorySessionStore, SESSION_TTL_MS } from "../src/session.js";

const TOKEN = "model_session_token_1234567890";
const NOW = Date.parse("2026-09-30T09:00:00.000Z");

const deps = (overrides: Partial<MiniappApiDeps> = {}): MiniappApiDeps => ({
  botToken: "model:bot-token",
  sessions: new InMemorySessionStore(
    () => NOW,
    () => TOKEN,
  ),
  verifyInitData: () => ({ maxUserId: 101, authDate: NOW / 1000, chat: { id: 202, type: "DIALOG" } }),
  companyOf: async () => "model-company",
  profile: async () => ({ companyId: "model-company", inn: "7700000016" }) as CompanyProfile,
  checklist: async () =>
    ({ status: "ok", profile: {} as CompanyProfile, checklist: { companyId: "model-company" } }) as ChecklistOutcome,
  settingsFor: async () => undefined,
  saveSettings: async () => undefined,
  ...overrides,
});

const authorize = async (api: ReturnType<typeof createMiniappApi>): Promise<string> => {
  const response = await api({ method: "POST", path: "/v1/session", body: { initData: "signed" } });
  expect(response.status).toBe(201);
  return (response.body as { token: string }).token;
};

describe("miniapp API", () => {
  it("rejects unsigned initData with a generic 401", async () => {
    const api = createMiniappApi(deps({ verifyInitData }));
    await expect(api({ method: "POST", path: "/v1/session", body: { initData: "unsigned" } })).resolves.toEqual({
      status: 401,
      body: { error: "UNAUTHENTICATED" },
    });
  });

  it("keeps health available but rejects login when the bot token is not configured", async () => {
    const api = createMiniappApi(deps({ botToken: "" }));
    await expect(api({ method: "GET", path: "/health" })).resolves.toEqual({ status: 200, body: { status: "ok" } });
    await expect(api({ method: "POST", path: "/v1/session", body: { initData: "signed" } })).resolves.toEqual({
      status: 503,
      body: { error: "SERVICE_UNAVAILABLE" },
    });
  });

  it("creates a one-hour session using only the signed dialog", async () => {
    const companyOf = vi.fn(async () => "model-company");
    const api = createMiniappApi(deps({ companyOf }));
    const response = await api({ method: "POST", path: "/v1/session", body: { initData: "signed" } });

    expect(companyOf).toHaveBeenCalledWith("202");
    expect(response).toEqual({
      status: 201,
      body: {
        token: TOKEN,
        companyId: "model-company",
        expiresAt: new Date(NOW + SESSION_TTL_MS).toISOString(),
      },
    });
  });

  it("rejects group chats and launches without a signed chat", async () => {
    for (const verified of [
      { maxUserId: 101, authDate: NOW / 1000, chat: { id: 202, type: "CHAT" } },
      { maxUserId: 101, authDate: NOW / 1000 },
    ]) {
      const companyOf = vi.fn(async () => "model-company");
      const api = createMiniappApi(deps({ verifyInitData: () => verified, companyOf }));
      expect(await api({ method: "POST", path: "/v1/session", body: { initData: "signed" } })).toEqual({
        status: 401,
        body: { error: "UNAUTHENTICATED" },
      });
      expect(companyOf).not.toHaveBeenCalled();
    }
  });

  it("returns profile and checklist only for the session company", async () => {
    const profile = vi.fn(async () => ({ companyId: "model-company", inn: "7700000016" }) as CompanyProfile);
    const checklist = vi.fn(
      async () => ({ status: "profile_not_found", companyId: "model-company" }) as ChecklistOutcome,
    );
    const api = createMiniappApi(deps({ profile, checklist }));
    const token = await authorize(api);

    expect(await api({ method: "GET", path: "/v1/profile", authorization: `Bearer ${token}` })).toEqual({
      status: 200,
      body: { companyId: "model-company", inn: "77******16" },
    });
    expect(await api({ method: "GET", path: "/v1/checklist", authorization: `Bearer ${token}` })).toEqual({
      status: 404,
      body: { error: "COMPANY_NOT_FOUND" },
    });
    expect(profile).toHaveBeenCalledWith("model-company");
    expect(checklist).toHaveBeenCalledWith("model-company");
  });

  it("validates and persists notification settings", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const api = createMiniappApi(deps({ saveSettings }));
    const token = await authorize(api);

    const invalid = await api({
      method: "PUT",
      path: "/v1/settings",
      authorization: `Bearer ${token}`,
      body: { enabled: "yes" },
    });
    expect(invalid.status).toBe(400);

    const settings = { enabled: false, earlySignals: true };
    expect(
      await api({ method: "PUT", path: "/v1/settings", authorization: `Bearer ${token}`, body: settings }),
    ).toEqual({ status: 200, body: settings });
    expect(saveSettings).toHaveBeenCalledWith("model-company", settings);
  });

  it("expires and revokes sessions", async () => {
    let now = NOW;
    const sessions = new InMemorySessionStore(
      () => now,
      () => TOKEN,
    );
    const api = createMiniappApi(deps({ sessions }));
    const token = await authorize(api);
    expect(await api({ method: "DELETE", path: "/v1/session", authorization: `Bearer ${token}` })).toEqual({
      status: 204,
    });
    expect(await api({ method: "GET", path: "/v1/profile", authorization: `Bearer ${token}` })).toMatchObject({
      status: 401,
    });

    await authorize(api);
    now += SESSION_TTL_MS;
    await authorize(api);
    expect(sessions.size).toBe(1);
  });
});
