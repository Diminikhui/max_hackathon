export interface RegionEntry {
  /** Two-digit subject code used by the Federal Tax Service. */
  code: string;
  /** Official name from the FTS subject reference (SSRF). */
  name: string;
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ";" && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error("Некорректный CSV регионов: незакрытое поле в кавычках");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

/** Parses a headerless, semicolon-separated `code;name` extract of the FTS SSRF reference. */
export function parseRegionsCsv(csv: string): RegionEntry[] {
  return parseCsvRows(csv).map((fields, index) => {
    if (fields.length !== 2) {
      throw new Error(`Некорректная строка CSV регионов ${index + 1}: ожидалось 2 поля`);
    }

    const code = fields[0]?.replace(/^\uFEFF/, "").trim() ?? "";
    const name = fields[1]?.trim() ?? "";
    if (!/^\d{2}$/.test(code)) {
      throw new Error(`Некорректный код региона в строке ${index + 1}: ${code}`);
    }
    if (name.length === 0) {
      throw new Error(`Некорректное наименование региона в строке ${index + 1}`);
    }
    return { code, name };
  });
}

/** In-memory lookup for the supported subject-code extract. */
export class RegionReference {
  readonly entries: readonly RegionEntry[];
  readonly #byCode: ReadonlyMap<string, RegionEntry>;

  constructor(entries: readonly RegionEntry[]) {
    const byCode = new Map<string, RegionEntry>();
    for (const entry of entries) {
      if (byCode.has(entry.code)) throw new Error(`Повторяющийся код региона: ${entry.code}`);
      byCode.set(entry.code, entry);
    }
    this.entries = [...entries];
    this.#byCode = byCode;
  }

  getByCode(code: string): RegionEntry | undefined {
    return this.#byCode.get(code.trim());
  }
}
