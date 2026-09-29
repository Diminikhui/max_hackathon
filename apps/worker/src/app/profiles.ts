// K-30b. Источник профиля для бота: модельные ИНН K-28 — из фикстуры, остальные — из реестра МСП (K-12b).
import type { CompanyProfile, FactValue, Id } from "@max-hackathon/domain";

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
