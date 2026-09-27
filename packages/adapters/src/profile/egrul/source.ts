// K-12a. Real-`ProfileSource` по ЕГРЮЛ/ЕГРИП — запасной источник профиля.
// Работает по выгрузкам файловой интеграции ФНС (распакованные XML в каталоге `EGRUL_DATA_DIR`).
// Документированного публичного API поиска по ИНН нет (K-04a), поэтому запросы к веб-интерфейсу
// egrul.nalog.ru не используются. Без выгрузок источник честно отвечает `unavailable`.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileLookupResult, ProfileSource, SourceInfo } from "@max-hackathon/domain";
import { type EgrulRecord, latestByInn, parseEgrulXml, recordToProfile } from "./records.js";

/** Стабильные коды `unavailable`. */
export const EGRUL_ERROR_CODES = {
  /** Каталог выгрузок не задан: реальный источник не подключён. */
  notConfigured: "egrul_not_configured",
  /** Выгрузки не прочитались или не разобрались. */
  loadFailed: "egrul_load_failed",
} as const;

const INN_PATTERN = /^\d{10}(\d{2})?$/;
const ENCODING = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i;

/** Декодирует XML по объявленной кодировке; ФНС отдаёт `windows-1251`. */
export function decodeEgrulXml(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const encoding = ENCODING.exec(head)?.[1] ?? "windows-1251";
  return new TextDecoder(encoding).decode(bytes);
}

/** Читает все `*.xml` из каталога выгрузок (ZIP распаковывается заранее). */
export async function loadEgrulDirectory(dir: string): Promise<EgrulRecord[]> {
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".xml")).sort();
  if (files.length === 0) throw new Error(`В каталоге ${dir} нет XML-выгрузок ЕГРЮЛ/ЕГРИП`);
  const records: EgrulRecord[] = [];
  for (const file of files) {
    records.push(...parseEgrulXml(decodeEgrulXml(await readFile(join(dir, file)))));
  }
  return records;
}

export interface EgrulProfileSourceOptions {
  /** Загрузчик записей. Без него источник не подключён и отвечает `egrul_not_configured`. */
  load?: () => Promise<readonly EgrulRecord[]>;
  /** Модельные выгрузки (тесты, демонстрация). По умолчанию `false`: данные ФНС. */
  isModel?: boolean;
}

export class EgrulProfileSource implements ProfileSource {
  readonly info: SourceInfo;
  readonly #load: EgrulProfileSourceOptions["load"];
  #byInn: Promise<Map<string, EgrulRecord>> | undefined;

  constructor(options: EgrulProfileSourceOptions = {}) {
    this.#load = options.load;
    this.info = { name: "egrul", isModel: options.isModel ?? false };
  }

  /** Источник из окружения: `EGRUL_DATA_DIR` — каталог распакованных XML-выгрузок ФНС. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): EgrulProfileSource {
    const dir = env["EGRUL_DATA_DIR"]?.trim();
    return new EgrulProfileSource(dir ? { load: () => loadEgrulDirectory(dir) } : {});
  }

  async lookupByInn(inn: string): Promise<ProfileLookupResult> {
    const normalized = typeof inn === "string" ? inn.trim() : "";
    if (!INN_PATTERN.test(normalized)) return { status: "not_found" };
    const load = this.#load;
    if (!load) return { status: "unavailable", errorCode: EGRUL_ERROR_CODES.notConfigured, retryable: false };
    this.#byInn ??= load().then(latestByInn);
    let byInn: Map<string, EgrulRecord>;
    try {
      byInn = await this.#byInn;
    } catch {
      this.#byInn = undefined; // следующая попытка перечитает выгрузки
      return { status: "unavailable", errorCode: EGRUL_ERROR_CODES.loadFailed, retryable: true };
    }
    const record = byInn.get(normalized);
    // Прекратившая деятельность компания не даёт профиль: требования к ней не применяются.
    if (!record || record.terminated) return { status: "not_found" };
    return { status: "found", profile: recordToProfile(record, { isModel: this.info.isModel }) };
  }
}
