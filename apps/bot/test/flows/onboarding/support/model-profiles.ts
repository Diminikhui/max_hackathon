// Модельный сервис профиля: форма ответов как у `ProfileService` K-25b, данные — из модельной кофейни K-28.
// ИНН и названия вымышленные, все профили помечены `isModel`.
import { CONTRACT_VERSION, type CompanyProfile, type Fact, type SourceInfo } from "@max-hackathon/domain";
import type { ProfileConfirmView, ProfileGateway, ProfileLookupView } from "../../../../src/flows/onboarding/index.js";

export const CAFE_INN = "7700000016";
/** Вторая модельная компания — для смены компании из меню. */
export const KAZAN_CAFE_INN = "1600000011";
export const MISSING_INN = "7700000024";
export const OUTAGE_INN = "7700000032";
export const MODEL_SOURCE: SourceInfo = { name: "Модельный источник профилей (K-11)", isModel: true };

const RETRIEVED_AT = "2026-09-25T09:00:00Z";

const fact = (key: string, value: Fact["value"], kind: Fact["kind"] = "official"): Fact => ({
  id: `model-cafe.${key}.${kind}`,
  companyId: "model-cafe",
  key,
  value,
  kind,
  source: { system: kind === "declared" ? "user" : "fixture", retrievedAt: RETRIEVED_AT, isModel: true },
  observedAt: RETRIEVED_AT,
});

export const modelCafe = (facts: Fact[] = []): CompanyProfile => ({
  contractVersion: CONTRACT_VERSION,
  companyId: "model-cafe",
  inn: CAFE_INN,
  entityType: "legal_entity",
  displayName: "Кофейня «Модель» (модельные данные)",
  isModel: true,
  updatedAt: RETRIEVED_AT,
  facts: [
    fact("activity.okved_main", "56.10"),
    fact("activity.okved_additional", ["47.25"]),
    fact("location.region_code", "77"),
    fact("scale.msp_category", "micro"),
    fact("employment.headcount", 12),
    ...facts,
  ],
});

export { fact as modelFact };

export interface ModelProfileGateway extends ProfileGateway {
  readonly lookups: string[];
  readonly confirmed: CompanyProfile[];
}

/**
 * Проверка ИНН упрощена до длины: контрольную сумму проверяет K-25a, здесь важны только ветви ответа.
 * `failConfirm` — сколько первых подтверждений завершится исключением хранилища.
 */
export const modelProfileGateway = (options: { failConfirm?: number; alreadySaved?: boolean } = {}) => {
  let failures = options.failConfirm ?? 0;
  const gateway: ModelProfileGateway = {
    lookups: [],
    confirmed: [],
    async lookup(input: string): Promise<ProfileLookupView> {
      gateway.lookups.push(input);
      if (input.length !== 10 && input.length !== 12) {
        return {
          status: "invalid_inn",
          error: { code: "invalid_length", message: "В ИНН должно быть 10 или 12 цифр." },
        };
      }
      if (input === CAFE_INN) {
        return {
          status: "found",
          profile: modelCafe(),
          source: MODEL_SOURCE,
          alreadySaved: options.alreadySaved ?? false,
        };
      }
      if (input === KAZAN_CAFE_INN) {
        return {
          status: "found",
          profile: {
            ...modelCafe(),
            companyId: "model-cafe-kzn",
            inn: KAZAN_CAFE_INN,
            displayName: "Кафе «Модель», Казань (модельные данные)",
          },
          source: MODEL_SOURCE,
          alreadySaved: false,
        };
      }
      if (input === OUTAGE_INN) {
        return {
          status: "unavailable",
          inn: input,
          errorCode: "timeout",
          retryable: true,
          message: "Источник данных о компаниях сейчас недоступен. Попробуйте ещё раз позже.",
        };
      }
      return {
        status: "not_found",
        inn: input,
        message: "Компания с таким ИНН не найдена в реестре малого и среднего бизнеса ФНС.",
      };
    },
    async confirm(profile: CompanyProfile): Promise<ProfileConfirmView> {
      if (failures > 0) {
        failures -= 1;
        throw new Error("model repository is down");
      }
      gateway.confirmed.push(profile);
      return { status: "ok", companyId: profile.companyId, profile };
    },
  };
  return gateway;
};
