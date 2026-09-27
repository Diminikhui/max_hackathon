/**
 * 4-11. Модель входа через ЕСИА.
 *
 * Это локальная fixture-модель, а не интеграция с ЕСИА. Она не проверяет реальные
 * учётные записи и не должна использоваться как источник юридически значимых полномочий.
 */

export const MODEL_ESIA_NOTICE = "Модельный вход: данные не получены из ЕСИА";

export interface ModelIdentityUser {
  readonly id: string;
  readonly displayName: string;
}

export interface ModelOrganizationAccess {
  readonly organizationId: string;
  readonly companyId: string;
  readonly inn: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
}

export interface ModelIdentityAccount {
  readonly user: ModelIdentityUser;
  readonly organizations: readonly ModelOrganizationAccess[];
}

export interface ModelIdentitySession {
  readonly id: string;
  readonly user: ModelIdentityUser;
  readonly availableOrganizations: readonly ModelOrganizationAccess[];
  readonly selectedOrganization?: ModelOrganizationAccess;
  readonly isModel: true;
  readonly notice: typeof MODEL_ESIA_NOTICE;
}

export type ModelSignInResult =
  | { readonly status: "authenticated"; readonly session: ModelIdentitySession }
  | { readonly status: "invalid_credentials" };

export type ModelOrganizationSelectionResult =
  | { readonly status: "selected"; readonly session: ModelIdentitySession }
  | { readonly status: "session_not_found" }
  | { readonly status: "organization_not_available" };
