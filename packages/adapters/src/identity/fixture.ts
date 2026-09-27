import {
  MODEL_ESIA_NOTICE,
  type ModelIdentityAccount,
  type ModelIdentitySession,
  type ModelOrganizationAccess,
  type ModelOrganizationSelectionResult,
  type ModelSignInResult,
} from "./model.js";

const cloneAccess = (access: ModelOrganizationAccess): ModelOrganizationAccess => ({
  ...access,
  permissions: [...access.permissions],
});

const cloneSession = (session: ModelIdentitySession): ModelIdentitySession => ({
  ...session,
  user: { ...session.user },
  availableOrganizations: session.availableOrganizations.map(cloneAccess),
  ...(session.selectedOrganization ? { selectedOrganization: cloneAccess(session.selectedOrganization) } : {}),
});

/**
 * Fixture-аутентификация для демонстрационного контура.
 *
 * Организация и полномочия всегда берутся из серверной fixture по субъекту и
 * идентификатору организации. Метод выбора намеренно не принимает ИНН,
 * наименование или полномочия от клиента.
 */
export class FixtureEsiaIdentityProvider {
  readonly info = { name: "model-esia-fixture", isModel: true } as const;
  readonly #accounts = new Map<string, ModelIdentityAccount>();
  readonly #sessions = new Map<string, ModelIdentitySession>();
  readonly #sessionId: () => string;

  constructor(accounts: readonly ModelIdentityAccount[], sessionId: () => string = () => crypto.randomUUID()) {
    this.#sessionId = sessionId;
    for (const account of accounts) {
      if (this.#accounts.has(account.user.id)) throw new Error(`Повтор модельного пользователя: ${account.user.id}`);
      const organizationIds = new Set<string>();
      for (const organization of account.organizations) {
        if (organizationIds.has(organization.organizationId)) {
          throw new Error(`Повтор организации ${organization.organizationId} у пользователя ${account.user.id}`);
        }
        organizationIds.add(organization.organizationId);
      }
      this.#accounts.set(account.user.id, structuredClone(account));
    }
  }

  signIn(modelSubjectId: string): ModelSignInResult {
    const account = this.#accounts.get(modelSubjectId);
    if (!account) return { status: "invalid_credentials" };

    const session: ModelIdentitySession = {
      id: this.#sessionId(),
      user: { ...account.user },
      availableOrganizations: account.organizations.map(cloneAccess),
      isModel: true,
      notice: MODEL_ESIA_NOTICE,
    };
    this.#sessions.set(session.id, session);
    return { status: "authenticated", session: cloneSession(session) };
  }

  selectOrganization(sessionId: string, organizationId: string): ModelOrganizationSelectionResult {
    const session = this.#sessions.get(sessionId);
    if (!session) return { status: "session_not_found" };

    const selected = session.availableOrganizations.find((item) => item.organizationId === organizationId);
    if (!selected) return { status: "organization_not_available" };

    const updated: ModelIdentitySession = { ...session, selectedOrganization: cloneAccess(selected) };
    this.#sessions.set(sessionId, updated);
    return { status: "selected", session: cloneSession(updated) };
  }

  getSession(sessionId: string): ModelIdentitySession | undefined {
    const session = this.#sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }
}
