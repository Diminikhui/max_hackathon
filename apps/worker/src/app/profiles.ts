// K-30b. Источник профиля для бота: модельные ИНН K-28 — из фикстуры, остальные — из реестра МСП (K-12b).
import type {
  CompanyProfile,
  FactValue,
  Id,
  ProfileLookupResult,
  ProfileRepository,
  ProfileSource,
} from "@max-hackathon/domain";

/**
 * Параметры реестра МСП для бота (#370). Обычный ответ приходит меньше чем за 1 с, но иногда первый запрос после
 * паузы около 12 с остаётся без ответа и обрывается пустым ответом, а следующий проходит сразу. Поэтому попытка
 * короче (8 с), а повторов два. Худший случай — 3 × 8 с + 2 × 0,5 с = 25 с, меньше `proxy_read_timeout 30s` у
 * webhook в `deploy/nginx-ip.conf`.
 */
export const MSP_BOT_LOOKUP = { timeoutMs: 8_000, retries: 2, retryDelayMs: 500 } as const;

/** Нужная журналу часть `TransportLogger`. */
export interface LookupLogger {
  info(event: string, message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(event: string, message: string, context?: Readonly<Record<string, unknown>>): void;
}

/**
 * Пишет в журнал итог каждого поиска по реальному источнику (#370): статус, код ошибки и длительность — без них
 * по журналу не понять, почему пользователь увидел «источник недоступен». ИНН не пишется: у ИП это персональные
 * данные (K-32b).
 */
export const loggedProfileSource = (
  source: ProfileSource,
  logger: LookupLogger,
  clock: () => number = Date.now,
): ProfileSource => ({
  info: source.info,
  lookupByInn: async (inn: string): Promise<ProfileLookupResult> => {
    const startedAt = clock();
    const context = (fields: Record<string, unknown>) => ({
      source: source.info.name,
      ...fields,
      durationMs: clock() - startedAt,
    });
    let result: ProfileLookupResult;
    try {
      result = await source.lookupByInn(inn);
    } catch (error) {
      logger.warn("profile.lookup", "Profile source threw", context({ status: "error", errorCode: errorName(error) }));
      throw error;
    }
    if (result.status === "unavailable") {
      logger.warn(
        "profile.lookup",
        "Profile source is unavailable",
        context({ status: result.status, errorCode: result.errorCode, retryable: result.retryable }),
      );
    } else {
      logger.info("profile.lookup", "Profile source answered", context({ status: result.status }));
    }
    return result;
  },
});

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/**
 * Хранилище для модельного `ProfileService`: сохранённый профиль по ИНН не подмешивается. Модельную компанию K-28
 * выбирают все проверяющие, поэтому каждый выбор начинается с фикстуры: `save` заменяет факты профиля, и ответы на
 * уточнения прошлого проверяющего не переносятся — вопросы задаются заново. Остальные методы — те же.
 */
export const freshModelProfiles = (repository: ProfileRepository): ProfileRepository => ({
  get: (companyId) => repository.get(companyId),
  findByInn: async () => undefined,
  save: (profile) => repository.save(profile),
  addFacts: (companyId, facts) => repository.addFacts(companyId, facts),
  listCompanyIds: () => repository.listCompanyIds(),
});

/** Нужная боту часть `ProfileService` K-25b. */
export interface ProfileServiceLike {
  lookup(input: string): Promise<unknown>;
  confirm(profile: CompanyProfile): Promise<unknown>;
  declare(companyId: Id, key: string, value: FactValue): Promise<unknown>;
}

export type ProfileGatewayOf<Service extends ProfileServiceLike> = Pick<Service, "lookup" | "confirm" | "declare">;

/**
 * Два `ProfileService` над одним хранилищем профилей: модельный (`FixtureProfileSource`) и реальный
 * (`MspProfileSource`). Выбор по ИНН, поэтому модельные компании проверяющего не уходят в реестр МСП, а реальный
 * ИНН не подменяется вымышленными данными. Подтверждение и заявленные факты пишутся в то же хранилище.
 */
export const createProfileGateway = <Service extends ProfileServiceLike>(options: {
  readonly model: Service;
  readonly real: Service;
  readonly modelInns: ReadonlySet<string>;
}): ProfileGatewayOf<Service> => {
  const { model, real, modelInns } = options;
  const pick = (input: string): Service => (modelInns.has(input.trim()) ? model : real);
  const gateway: ProfileServiceLike = {
    lookup: (input) => pick(input).lookup(input),
    confirm: (profile) => (profile.isModel ? model : real).confirm(profile),
    declare: (companyId, key, value) => real.declare(companyId, key, value),
  };
  return gateway as ProfileGatewayOf<Service>;
};
