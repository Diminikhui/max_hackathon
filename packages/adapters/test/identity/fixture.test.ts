import { describe, expect, it } from "vitest";
import { FixtureEsiaIdentityProvider, MODEL_ESIA_NOTICE, type ModelIdentityAccount } from "../../src/index.js";

const accounts: ModelIdentityAccount[] = [
  {
    user: { id: "model-user-owner", displayName: "Модельный пользователь" },
    organizations: [
      {
        organizationId: "model-org-cafe-msk",
        companyId: "k28-cafe-msk",
        inn: "7700000016",
        displayName: "Кофейня «Модель», Москва (модельные данные)",
        permissions: ["profile:read", "profile:edit", "requirements:read"],
      },
      {
        organizationId: "model-org-cafe-kzn",
        companyId: "k28-cafe-kzn",
        inn: "1600000011",
        displayName: "Кафе «Модель», Казань (модельные данные)",
        permissions: ["profile:read", "requirements:read"],
      },
    ],
  },
];

const createProvider = () => new FixtureEsiaIdentityProvider(accounts, () => "model-session-1");

describe("FixtureEsiaIdentityProvider", () => {
  it("явно помечает провайдер и сессию модельными", () => {
    const provider = createProvider();
    expect(provider.info).toEqual({ name: "model-esia-fixture", isModel: true });
    const result = provider.signIn("model-user-owner");
    expect(result).toEqual({
      status: "authenticated",
      session: expect.objectContaining({ isModel: true, notice: MODEL_ESIA_NOTICE }),
    });
  });

  it("создаёт сессию пользователя и возвращает доступные организации с полномочиями", () => {
    const result = createProvider().signIn("model-user-owner");
    if (result.status !== "authenticated") throw new Error("ожидалась модельная аутентификация");
    expect(result.session.user).toEqual(accounts[0]?.user);
    expect(result.session.availableOrganizations).toEqual(accounts[0]?.organizations);
    expect(result.session.selectedOrganization).toBeUndefined();
  });

  it("выбирает организацию по серверной fixture вместо ручного ввода ИНН", () => {
    const provider = createProvider();
    const signedIn = provider.signIn("model-user-owner");
    if (signedIn.status !== "authenticated") throw new Error("ожидалась модельная аутентификация");

    const result = provider.selectOrganization(signedIn.session.id, "model-org-cafe-kzn");
    expect(result).toEqual({
      status: "selected",
      session: expect.objectContaining({
        selectedOrganization: accounts[0]?.organizations[1],
      }),
    });
  });

  it("отказывает в выборе организации, которой нет в полномочиях пользователя", () => {
    const provider = createProvider();
    const signedIn = provider.signIn("model-user-owner");
    if (signedIn.status !== "authenticated") throw new Error("ожидалась модельная аутентификация");

    expect(provider.selectOrganization(signedIn.session.id, "model-org-unavailable")).toEqual({
      status: "organization_not_available",
    });
    expect(provider.getSession(signedIn.session.id)?.selectedOrganization).toBeUndefined();
  });

  it("не принимает неизвестного пользователя или неизвестную сессию", () => {
    const provider = createProvider();
    expect(provider.signIn("client-supplied-user")).toEqual({ status: "invalid_credentials" });
    expect(provider.selectOrganization("client-supplied-session", "model-org-cafe-msk")).toEqual({
      status: "session_not_found",
    });
  });

  it("не доверяет изменениям данных, возвращённых клиенту", () => {
    const provider = createProvider();
    const signedIn = provider.signIn("model-user-owner");
    if (signedIn.status !== "authenticated") throw new Error("ожидалась модельная аутентификация");

    const clientOrganization = signedIn.session.availableOrganizations[0];
    if (!clientOrganization) throw new Error("ожидалась организация");
    (clientOrganization.permissions as string[]).push("admin:all");

    const selected = provider.selectOrganization(signedIn.session.id, clientOrganization.organizationId);
    if (selected.status !== "selected") throw new Error("ожидался выбор организации");
    expect(selected.session.selectedOrganization?.permissions).not.toContain("admin:all");
  });

  it("не отдаёт наружу изменяемое внутреннее состояние сессии", () => {
    const provider = createProvider();
    const signedIn = provider.signIn("model-user-owner");
    if (signedIn.status !== "authenticated") throw new Error("ожидалась модельная аутентификация");
    (signedIn.session.user as { displayName: string }).displayName = "Подмена";

    expect(provider.getSession(signedIn.session.id)?.user.displayName).toBe("Модельный пользователь");
  });

  it("отклоняет повтор пользователя или организации в конфигурации", () => {
    expect(() => new FixtureEsiaIdentityProvider([accounts[0]!, accounts[0]!])).toThrow(
      /Повтор модельного пользователя/,
    );
    expect(
      () =>
        new FixtureEsiaIdentityProvider([
          {
            user: { id: "duplicate-org-user", displayName: "Модельный пользователь" },
            organizations: [accounts[0]!.organizations[0]!, accounts[0]!.organizations[0]!],
          },
        ]),
    ).toThrow(/Повтор организации/);
  });
});
