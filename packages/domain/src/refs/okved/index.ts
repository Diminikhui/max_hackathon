export type OkvedLevel = "section" | "class" | "subclass" | "group" | "subgroup" | "type";

export interface OkvedEntry {
  /** Stable identifier: `section:I` for a section or `code:56.10` for a code. */
  id: string;
  section: string;
  code: string | null;
  name: string;
  level: OkvedLevel;
  parentId: string | null;
}

const LEVEL_BY_DIGIT_COUNT: Readonly<Record<number, Exclude<OkvedLevel, "section">>> = {
  2: "class",
  3: "subclass",
  4: "group",
  5: "subgroup",
  6: "type",
};

function formatCodeDigits(digits: string): string {
  if (digits.length === 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

function codeLevel(code: string): Exclude<OkvedLevel, "section"> {
  const level = LEVEL_BY_DIGIT_COUNT[code.replaceAll(".", "").length];
  if (!level) throw new Error(`Некорректная длина кода ОКВЭД: ${code}`);
  return level;
}

function codeParentId(code: string, section: string): string {
  const digits = code.replaceAll(".", "");
  return digits.length === 2 ? `section:${section}` : `code:${formatCodeDigits(digits.slice(0, -1))}`;
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

  if (quoted) throw new Error("Некорректный CSV ОКВЭД: незакрытое поле в кавычках");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

/** Parses the three-column semicolon-separated CSV published by Rosstat. */
export function parseOkvedCsv(csv: string): OkvedEntry[] {
  return parseCsvRows(csv).map((fields, index) => {
    if (fields.length !== 3) throw new Error(`Некорректная строка CSV ОКВЭД ${index + 1}: ожидалось 3 поля`);

    const section = fields[0]?.replace(/^\uFEFF/, "").trim() ?? "";
    const code = fields[1]?.trim() ?? "";
    const name = fields[2]?.trim() ?? "";
    if (!/^[A-Z]$/.test(section) || name.length === 0) {
      throw new Error(`Некорректная строка CSV ОКВЭД ${index + 1}: отсутствует раздел или наименование`);
    }

    if (code.length === 0) {
      return { id: `section:${section}`, section, code: null, name, level: "section", parentId: null };
    }
    if (!/^\d{2}(?:\.\d{1,2}){0,2}$/.test(code)) {
      throw new Error(`Некорректный код ОКВЭД в строке ${index + 1}: ${code}`);
    }

    return {
      id: `code:${code}`,
      section,
      code,
      name,
      level: codeLevel(code),
      parentId: codeParentId(code, section),
    };
  });
}

/** In-memory hierarchy and deterministic prefix search over an OKVED2 snapshot. */
export class OkvedReference {
  readonly entries: readonly OkvedEntry[];
  readonly #byId: ReadonlyMap<string, OkvedEntry>;
  readonly #byCode: ReadonlyMap<string, OkvedEntry>;

  constructor(entries: readonly OkvedEntry[]) {
    const byId = new Map<string, OkvedEntry>();
    const byCode = new Map<string, OkvedEntry>();
    for (const entry of entries) {
      if (byId.has(entry.id)) throw new Error(`Повторяющаяся запись ОКВЭД: ${entry.id}`);
      byId.set(entry.id, entry);
      if (entry.code !== null) byCode.set(entry.code, entry);
    }
    this.entries = [...entries];
    this.#byId = byId;
    this.#byCode = byCode;
  }

  getByCode(code: string): OkvedEntry | undefined {
    return this.#byCode.get(code.trim());
  }

  searchByPrefix(prefix: string): OkvedEntry[] {
    const normalized = prefix.trim();
    if (normalized.length === 0) return [];
    if (!/^\d{1,2}(?:\.\d{1,2}){0,2}$/.test(normalized)) {
      throw new Error(`Некорректный префикс ОКВЭД: ${prefix}`);
    }
    return this.entries.filter((entry) => entry.code?.startsWith(normalized));
  }

  childrenOf(idOrCode: string): OkvedEntry[] {
    const id = this.#byId.has(idOrCode)
      ? idOrCode
      : /^[A-Z]$/.test(idOrCode)
        ? `section:${idOrCode}`
        : `code:${idOrCode}`;
    return this.entries.filter((entry) => entry.parentId === id);
  }

  ancestorsOf(code: string): OkvedEntry[] {
    const result: OkvedEntry[] = [];
    let current = this.#byCode.get(code.trim());
    while (current?.parentId) {
      const parent = this.#byId.get(current.parentId);
      if (!parent) break;
      result.push(parent);
      current = parent;
    }
    return result;
  }
}
