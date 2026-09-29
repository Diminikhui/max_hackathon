import type { CompanyProfile } from "@max-hackathon/domain";
import { InitDataError, maskInn, type VerifiedInitData } from "@max-hackathon/security";
import type { ChecklistOutcome } from "@max-hackathon/services";
import type { StoredNotificationSettings } from "@max-hackathon/storage";
import type { Session, SessionStore } from "./session.js";

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body?: unknown;
}

export interface MiniappApiDeps {
  readonly botToken: string;
  readonly sessions: SessionStore;
  readonly verifyInitData: (initData: unknown, botToken: string) => VerifiedInitData;
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
  readonly profile: (companyId: string) => Promise<CompanyProfile | undefined>;
  readonly checklist: (companyId: string) => Promise<ChecklistOutcome>;
  readonly settingsFor: (companyId: string) => Promise<StoredNotificationSettings | undefined>;
  readonly saveSettings: (companyId: string, settings: StoredNotificationSettings) => Promise<void>;
}

const jsonError = (status: number, code: string): ApiResponse => ({ status, body: { error: code } });

const bearerToken = (authorization: string | undefined): string | undefined => {
  const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(authorization ?? "");
  return match?.[1];
};

const notificationSettings = (body: unknown): StoredNotificationSettings | undefined => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (typeof value.enabled !== "boolean" || typeof value.earlySignals !== "boolean") return undefined;
  return { enabled: value.enabled, earlySignals: value.earlySignals };
};

const publicProfile = (profile: CompanyProfile): CompanyProfile => {
  const { displayName, ...rest } = profile;
  return {
    ...rest,
    inn: maskInn(profile.inn),
    ...(profile.entityType === "individual_entrepreneur" || displayName === undefined ? {} : { displayName }),
  };
};

export const createMiniappApi = (deps: MiniappApiDeps) => {
  const authenticate = (request: ApiRequest): Session | undefined => {
    const token = bearerToken(request.authorization);
    return token ? deps.sessions.get(token) : undefined;
  };

  return async (request: ApiRequest): Promise<ApiResponse> => {
    if (request.method === "GET" && request.path === "/health") return { status: 200, body: { status: "ok" } };

    if (request.method === "POST" && request.path === "/v1/session") {
      if (!deps.botToken) return jsonError(503, "SERVICE_UNAVAILABLE");
      const initData =
        request.body && typeof request.body === "object" && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>).initData
          : undefined;
      try {
        const verified = deps.verifyInitData(initData, deps.botToken);
        if (verified.chat?.type !== "DIALOG") return jsonError(401, "UNAUTHENTICATED");
        const dialogId = String(verified.chat.id);
        const companyId = await deps.companyOf(dialogId);
        if (!companyId) return jsonError(404, "COMPANY_NOT_FOUND");
        const session = deps.sessions.create({ maxUserId: verified.maxUserId, dialogId, companyId });
        return {
          status: 201,
          body: { token: session.token, expiresAt: session.expiresAt, companyId: session.companyId },
        };
      } catch (error) {
        if (error instanceof InitDataError) return jsonError(401, "UNAUTHENTICATED");
        throw error;
      }
    }

    const session = authenticate(request);
    if (!session) return jsonError(401, "UNAUTHENTICATED");

    if (request.method === "DELETE" && request.path === "/v1/session") {
      deps.sessions.revoke(session.token);
      return { status: 204 };
    }

    if (request.method === "GET" && request.path === "/v1/profile") {
      const profile = await deps.profile(session.companyId);
      return profile ? { status: 200, body: publicProfile(profile) } : jsonError(404, "COMPANY_NOT_FOUND");
    }

    if (request.method === "GET" && request.path === "/v1/checklist") {
      const outcome = await deps.checklist(session.companyId);
      return outcome.status === "ok" ? { status: 200, body: outcome.checklist } : jsonError(404, "COMPANY_NOT_FOUND");
    }

    if (request.method === "GET" && request.path === "/v1/settings") {
      return {
        status: 200,
        body: (await deps.settingsFor(session.companyId)) ?? { enabled: true, earlySignals: false },
      };
    }

    if (request.method === "PUT" && request.path === "/v1/settings") {
      const settings = notificationSettings(request.body);
      if (!settings) return jsonError(400, "INVALID_REQUEST");
      await deps.saveSettings(session.companyId, settings);
      return { status: 200, body: settings };
    }

    return jsonError(404, "NOT_FOUND");
  };
};
