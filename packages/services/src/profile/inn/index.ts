// K-25a: разбор ИНН, введённого владельцем бизнеса, — нормализация, длина и контрольная сумма.
// Сообщения показываются пользователю бота как есть, коды ошибок стабильны (на них опирается K-27).
import type { EntityType } from "@max-hackathon/domain";

/** Коды ошибок ввода ИНН. Стабильны: не переименовывайте без согласования с потребителями. */
export const INN_ERROR_CODES = ["empty", "invalid_characters", "invalid_length", "invalid_checksum"] as const;
export type InnErrorCode = (typeof INN_ERROR_CODES)[number];

export interface InnError {
  code: InnErrorCode;
  /** Текст для пользователя: что не так и что сделать. */
  message: string;
}

export type InnParseResult = { ok: true; inn: string; entityType: EntityType } | { ok: false; error: InnError };

const WEIGHTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const WEIGHTS_12_N11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const WEIGHTS_12_N12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

/** Пробельные символы (включая неразрывные) и дефисы/тире, которые люди ставят для удобства чтения. */
const SEPARATORS = /[\s   ⁠\-‐-―−]/gu;
/** Необязательная подпись «ИНН» / «ИНН:» / «ИНН №» в начале, если её скопировали вместе с номером. */
const LABEL_PREFIX = /^\s*инн\s*[:№#]?/iu;

export const INN_MESSAGES: Readonly<Record<InnErrorCode, string>> = {
  empty: "Введите ИНН: у организации это 10 цифр, у ИП — 12.",
  invalid_characters: "В ИНН должны быть только цифры. Уберите буквы и другие знаки и отправьте номер ещё раз.",
  invalid_length: "ИНН организации — 10 цифр, ИП — 12.",
  invalid_checksum:
    "Такого ИНН не бывает — похоже, в нём опечатка. Сверьте цифры с выпиской из реестра или свидетельством о постановке на учёт.",
};

function checkDigit(digits: readonly number[], weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += (digits[i] ?? 0) * (weights[i] ?? 0);
  }
  return (sum % 11) % 10;
}

/**
 * Проверяет контрольные цифры ИНН из 10 или 12 цифр.
 * Номер с кодом налогового органа «00» (в том числе из одних нулей) формально проходит контрольную сумму,
 * но не может быть выдан, поэтому тоже считается неверным.
 */
export function hasValidInnChecksum(inn: string): boolean {
  if (!/^(?:\d{10}|\d{12})$/.test(inn) || inn.startsWith("00")) {
    return false;
  }
  const digits = Array.from(inn, Number);
  if (digits.length === 10) {
    return checkDigit(digits, WEIGHTS_10) === digits[9];
  }
  return checkDigit(digits, WEIGHTS_12_N11) === digits[10] && checkDigit(digits, WEIGHTS_12_N12) === digits[11];
}

/** Убирает подпись «ИНН», пробелы и дефисы. Остальные символы сохраняются, чтобы сообщить о них. */
export function normalizeInnInput(input: string): string {
  return input.replace(LABEL_PREFIX, "").replace(SEPARATORS, "");
}

function digitsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "цифру";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "цифры";
  return "цифр";
}

function fail(code: InnErrorCode, message: string = INN_MESSAGES[code]): InnParseResult {
  return { ok: false, error: { code, message } };
}

/**
 * Разбирает ИНН, введённый пользователем.
 * 10 цифр — организация (`legal_entity`), 12 — ИП (`individual_entrepreneur`).
 * Порядок проверок: пусто → недопустимые символы → длина → контрольная сумма.
 */
export function parseInn(input: string): InnParseResult {
  const normalized = normalizeInnInput(input);
  if (normalized.length === 0) {
    return fail("empty");
  }
  if (!/^\d+$/.test(normalized)) {
    return fail("invalid_characters");
  }
  if (normalized.length !== 10 && normalized.length !== 12) {
    const count = normalized.length;
    return fail("invalid_length", `${INN_MESSAGES.invalid_length} Вы ввели ${count} ${digitsWord(count)}.`);
  }
  if (!hasValidInnChecksum(normalized)) {
    return fail("invalid_checksum");
  }
  return {
    ok: true,
    inn: normalized,
    entityType: normalized.length === 10 ? "legal_entity" : "individual_entrepreneur",
  };
}
