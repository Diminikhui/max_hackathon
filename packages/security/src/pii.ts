// Минимизация персональных данных: псевдонимы вместо идентификаторов и безопасные для логов представления.
import { createHmac } from "node:crypto";

/** Минимальная длина ключа псевдонимизации: короткий ключ перебирается по словарю id. */
export const PSEUDONYM_KEY_MIN_LENGTH = 32;

/**
 * Стабильный псевдоним идентификатора (id пользователя или чата MAX, ИНН ИП) для логов,
 * метрик и связей, где исходное значение не нужно. HMAC-SHA256 с секретным ключом, а не
 * простой хеш: id и ИНН перебираются, и хеш без ключа обратим. `purpose` разводит
 * псевдонимы разных назначений, чтобы их нельзя было сопоставить между собой.
 */
export function pseudonymize(value: string | number, key: string, purpose: string): string {
  if (key.length < PSEUDONYM_KEY_MIN_LENGTH) {
    throw new Error(`Ключ псевдонимизации короче ${PSEUDONYM_KEY_MIN_LENGTH} символов`);
  }
  if (!purpose) throw new Error("Не указано назначение псевдонима");
  const digest = createHmac("sha256", key)
    .update(`${purpose}\n${String(value)}`)
    .digest("base64url");
  return `p_${digest.slice(0, 22)}`;
}

/** Маска ИНН для интерфейса и поддержки: видны две первые и две последние цифры. */
export function maskInn(inn: string): string {
  if (!/^\d{10}(\d{2})?$/.test(inn)) return "***";
  return `${inn.slice(0, 2)}${"*".repeat(inn.length - 4)}${inn.slice(-2)}`;
}

/** Профиль по ИНН ИП относится к физическому лицу: ИНН из 12 цифр — персональные данные. */
export function isPersonalInn(inn: string): boolean {
  return /^\d{12}$/.test(inn);
}

export interface ProfileLike {
  companyId: string;
  inn: string;
  entityType: string;
  displayName?: string;
  facts?: readonly unknown[];
  isModel: boolean;
}

export interface LogSafeProfile {
  /** Псевдоним `companyId`: реальные id строятся из ИНН (`msp-<ИНН>`, `egrul-<ИНН>`). */
  companyRef: string;
  entityType: string;
  isModel: boolean;
  factCount: number;
}

/** Назначение псевдонима компании в логах и метриках. */
export const LOG_COMPANY_PURPOSE = "log.company";

/**
 * Представление профиля для логов и метрик: без ИНН и без названия, потому что у ИП
 * название — это ФИО. `companyId` заменяется псевдонимом: у реальных профилей он содержит
 * ИНН, у ИП — ИНН физического лица, а метрики не проходят через маскирование логгера.
 * Логгер из `@max-hackathon/observability` не маскирует `displayName`, поэтому профиль
 * целиком в контекст лога не передаётся.
 */
export function toLogSafeProfile(profile: ProfileLike, pseudonymKey: string): LogSafeProfile {
  return {
    companyRef: pseudonymize(profile.companyId, pseudonymKey, LOG_COMPANY_PURPOSE),
    entityType: profile.entityType,
    isModel: profile.isModel,
    factCount: profile.facts?.length ?? 0,
  };
}
