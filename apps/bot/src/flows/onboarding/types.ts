import type { CompanyProfile, SourceInfo } from "@max-hackathon/domain";

// Форма совпадает с `ProfileLookupOutcome` и `ConfirmOutcome` из @max-hackathon/services (K-25b): бот не зависит от
// пакета services, а `ProfileService` подходит к порту `ProfileGateway` без переходника.

export type ProfileLookupView =
  | { readonly status: "invalid_inn"; readonly error: { readonly code: string; readonly message: string } }
  | {
      readonly status: "found";
      readonly profile: CompanyProfile;
      readonly source: SourceInfo;
      readonly alreadySaved: boolean;
    }
  | { readonly status: "not_found"; readonly inn: string; readonly message: string }
  | {
      readonly status: "unavailable";
      readonly inn: string;
      readonly errorCode: string;
      readonly retryable: boolean;
      readonly message: string;
    };

export type ProfileConfirmView =
  | { readonly status: "ok"; readonly companyId: string; readonly profile: CompanyProfile }
  | { readonly status: "invalid_declaration"; readonly key: string; readonly message: string };

/** Сервис профиля K-25b: поиск по ИНН без сохранения и подтверждение с сохранением. */
export interface ProfileGateway {
  lookup(input: string): Promise<ProfileLookupView>;
  confirm(profile: CompanyProfile): Promise<ProfileConfirmView>;
}

/** Найденный по ИНН, но ещё не подтверждённый профиль. */
export interface PendingProfile {
  readonly profile: CompanyProfile;
  readonly source: SourceInfo;
  readonly alreadySaved: boolean;
}

/**
 * Данные онбординга, привязанные к диалогу: найденный, но ещё не подтверждённый профиль и компания после
 * подтверждения. `companyOf` — тот же порт, что ждёт сценарий перечня K-24b.
 */
export interface OnboardingSessions {
  pendingProfile(dialogId: string): Promise<PendingProfile | undefined>;
  setPendingProfile(dialogId: string, pending: PendingProfile | undefined): Promise<void>;
  companyOf(dialogId: string): Promise<string | undefined>;
  bindCompany(dialogId: string, companyId: string): Promise<void>;
}
