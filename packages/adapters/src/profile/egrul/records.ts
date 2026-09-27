// K-12a. Разбор файлов файловой интеграции ФНС (ЕГРЮЛ 4.08 / ЕГРИП 4.07, корни `EGRUL`/`EGRIP`)
// в плоские записи и их отображение в `CompanyProfile` v1. Карта полей — docs/research/k-04a-egrul-egrip.md.
import type { CompanyProfile, Fact } from "@max-hackathon/domain";
import { child, childrenNamed, parseXml, type XmlElement } from "./xml.js";

export const EGRUL_SYSTEM = "egrul.nalog.ru";

/** Сведения одной записи реестра, нужные профилю. ФИО ИП и адрес проживания не извлекаются (ПДн). */
export interface EgrulRecord {
  entityType: "legal_entity" | "individual_entrepreneur";
  inn: string;
  /** ОГРН или ОГРНИП. */
  ogrn: string;
  /** `ДатаВып` — дата состояния записи, `YYYY-MM-DD`. */
  statementDate: string;
  /** `ДатаВыг` файла — когда ФНС сформировала выгрузку, `YYYY-MM-DD`. */
  exportDate?: string;
  /** Только для организации. */
  name?: string;
  okvedMain?: string;
  okvedAdditional: string[];
  /** Код региона из адреса ЮЛ. Для ИП не заполняется: адрес проживания закрыт. */
  regionCode?: string;
  /** Есть сведения о прекращении деятельности. */
  terminated: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOTTED_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dotted = DOTTED_DATE.exec(value);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  return DATE.test(value) ? value : undefined;
}

function okveds(record: XmlElement): { main?: string; additional: string[] } {
  const block = child(record, "СвОКВЭД");
  if (!block) return { additional: [] };
  const main = child(block, "СвОКВЭДОсн")?.attrs["КодОКВЭД"];
  const additional = childrenNamed(block, "СвОКВЭДДоп")
    .map((e) => e.attrs["КодОКВЭД"])
    .filter((code): code is string => Boolean(code) && code !== main);
  return { ...(main ? { main } : {}), additional: [...new Set(additional)] };
}

function legalRegion(record: XmlElement): string | undefined {
  const address = child(record, "СвАдресЮЛ");
  if (!address) return undefined;
  const code =
    child(address, "АдресРФ")?.attrs["КодРегион"] ?? child(child(address, "СвАдрЮЛФИАС") ?? address, "Регион")?.text;
  const trimmed = code?.trim();
  return trimmed && /^\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function parseRecord(element: XmlElement, exportDate: string | undefined): EgrulRecord | undefined {
  const legal = element.name === "СвЮЛ";
  const inn = element.attrs[legal ? "ИНН" : "ИННФЛ"];
  const ogrn = element.attrs[legal ? "ОГРН" : "ОГРНИП"];
  const statementDate = normalizeDate(element.attrs["ДатаВып"]);
  if (!inn || !ogrn || !statementDate) return undefined;
  const { main, additional } = okveds(element);
  const names = child(element, "СвНаимЮЛ");
  const name = legal
    ? (child(names ?? element, "СвНаимЮЛСокр")?.attrs["НаимСокр"] ?? names?.attrs["НаимЮЛПолн"])
    : undefined;
  const regionCode = legal ? legalRegion(element) : undefined;
  return {
    entityType: legal ? "legal_entity" : "individual_entrepreneur",
    inn,
    ogrn,
    statementDate,
    ...(exportDate ? { exportDate } : {}),
    ...(name ? { name } : {}),
    ...(main ? { okvedMain: main } : {}),
    okvedAdditional: additional,
    ...(regionCode ? { regionCode } : {}),
    terminated: child(element, legal ? "СвПрекрЮЛ" : "СвПрекрИП") !== undefined,
  };
}

/** Разбирает один XML-файл выгрузки. Записи без ИНН, ОГРН или даты выписки пропускаются. */
export function parseEgrulXml(xml: string): EgrulRecord[] {
  const root = parseXml(xml);
  if (root.name !== "EGRUL" && root.name !== "EGRIP") {
    throw new Error(`Неизвестный корень выгрузки ФНС: <${root.name}>, ожидался EGRUL или EGRIP`);
  }
  const exportDate = normalizeDate(root.attrs["ДатаВыг"]);
  const recordName = root.name === "EGRUL" ? "СвЮЛ" : "СвИП";
  return childrenNamed(root, recordName)
    .map((element) => parseRecord(element, exportDate))
    .filter((record): record is EgrulRecord => record !== undefined);
}

/**
 * Оставляет по каждому ИНН самую свежую запись: более поздняя запись по ОГРН полностью заменяет
 * прежнюю (модель взаимодействия ФНС), поэтому поля не сливаются.
 */
export function latestByInn(records: Iterable<EgrulRecord>): Map<string, EgrulRecord> {
  const byInn = new Map<string, EgrulRecord>();
  for (const record of records) {
    const previous = byInn.get(record.inn);
    if (!previous || record.statementDate >= previous.statementDate) byInn.set(record.inn, record);
  }
  return byInn;
}

export interface ToProfileOptions {
  /** Модельные данные (тесты, демонстрация): помечаются `isModel = true` в профиле и фактах. */
  isModel: boolean;
  /** Когда сведения получены адаптером; по умолчанию — дата выгрузки или дата выписки. */
  retrievedAt?: string;
}

/** Строит профиль v1 из записи. Отсутствующее в выписке поле не превращается в факт («неизвестно»). */
export function recordToProfile(record: EgrulRecord, options: ToProfileOptions): CompanyProfile {
  const companyId = `egrul-${record.inn}`;
  const observedAt = `${record.statementDate}T00:00:00Z`;
  const retrievedAt = options.retrievedAt ?? `${record.exportDate ?? record.statementDate}T00:00:00Z`;
  const source = { system: EGRUL_SYSTEM, recordId: record.ogrn, retrievedAt, isModel: options.isModel };
  const facts: Fact[] = [];
  const add = (key: string, value: string | string[]) =>
    facts.push({
      id: `${companyId}-${key.replace(".", "-")}`,
      companyId,
      key,
      value,
      kind: "official",
      source: { ...source },
      observedAt,
    });
  if (record.okvedMain) add("activity.okved_main", record.okvedMain);
  if (record.okvedAdditional.length > 0) add("activity.okved_additional", [...record.okvedAdditional]);
  if (record.regionCode) add("location.region_code", record.regionCode);
  return {
    contractVersion: 1,
    companyId,
    inn: record.inn,
    entityType: record.entityType,
    ...(record.name ? { displayName: record.name } : {}),
    facts,
    isModel: options.isModel,
    updatedAt: observedAt,
  };
}
