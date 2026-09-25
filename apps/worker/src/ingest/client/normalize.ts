// Разбор записей портала в NpaProject. Имена полей портала документированы плохо и менялись,
// поэтому каждое поле ищется по нескольким вариантам имени без учёта регистра; пустые значения отбрасываются.
import type { FetchPage, NpaProject } from "./types.js";
import type { XmlElement } from "./xml.js";

export const PORTAL_URL = "https://regulation.gov.ru";

const FIELDS = {
  id: ["id", "projectId", "npaId"],
  title: ["title", "name", "npaName"],
  department: ["department", "departmentName", "regulator", "developer", "developedDepartment"],
  publishedAt: ["publishDate", "publicationDate", "date", "creationDate", "createDate"],
  stage: ["stage", "stageName", "procedure", "procedureName", "status"],
  sphereIds: ["okveds", "okved", "spheres"],
} as const;

export function projectUrl(id: string): string {
  return `${PORTAL_URL}/projects/${encodeURIComponent(id)}`;
}

function clean(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function toSphereId(value: unknown): number | undefined {
  const candidate = typeof value === "object" && value !== null ? (value as Record<string, unknown>).id : value;
  const number = typeof candidate === "string" ? Number(candidate.trim()) : candidate;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined;
}

function sphereIdsFrom(values: unknown[]): number[] {
  const ids = values.map(toSphereId).filter((id): id is number => id !== undefined);
  return [...new Set(ids)].sort((a, b) => a - b);
}

function build(fields: { [K in keyof typeof FIELDS]?: unknown }): NpaProject | undefined {
  const id = clean(fields.id);
  if (!id) return undefined;
  const project: NpaProject = { id, url: projectUrl(id), sphereIds: [] };
  const title = clean(fields.title);
  const department = clean(fields.department);
  const publishedAt = clean(fields.publishedAt);
  const stage = clean(fields.stage);
  if (title) project.title = title;
  if (department) project.department = department;
  if (publishedAt) project.publishedAt = publishedAt;
  if (stage) project.stage = stage;
  const spheres = fields.sphereIds;
  if (Array.isArray(spheres)) project.sphereIds = sphereIdsFrom(spheres);
  else if (typeof spheres === "string") project.sphereIds = sphereIdsFrom(spheres.split(/[,;\s]+/));
  else if (spheres !== undefined) project.sphereIds = sphereIdsFrom([spheres]);
  return project;
}

// --- JSON (GetFiltered) ---

function pick(record: Record<string, unknown>, names: readonly string[]): unknown {
  const lower = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const key = lower.get(name.toLowerCase());
    if (key !== undefined && record[key] !== null && record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** Нормализует одну запись JSON; возвращает undefined, если у неё нет идентификатора. */
export function projectFromJson(value: unknown): NpaProject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const department = pick(record, FIELDS.department);
  return build({
    id: pick(record, FIELDS.id),
    title: pick(record, FIELDS.title),
    department:
      typeof department === "object" && department !== null
        ? pick(department as Record<string, unknown>, ["name", "title"])
        : department,
    publishedAt: pick(record, FIELDS.publishedAt),
    stage: pick(record, FIELDS.stage),
    sphereIds: pick(record, FIELDS.sphereIds),
  });
}

/** Находит массив записей и общее число в ответе GetFiltered. */
export function pageFromJson(body: unknown): FetchPage & { total: number | undefined; received: number } {
  let list: unknown[] = [];
  let total: number | undefined;
  if (Array.isArray(body)) list = body;
  else if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const found = pick(record, ["items", "data", "projects", "results", "result", "list"]);
    if (Array.isArray(found)) list = found;
    const count = pick(record, ["total", "totalCount", "count", "totalItems"]);
    if (typeof count === "number" && Number.isFinite(count)) total = count;
  }
  const items = list.map(projectFromJson).filter((item): item is NpaProject => item !== undefined);
  return { items, skipped: list.length - items.length, total, received: list.length };
}

// --- XML (npalist) ---

function childText(element: XmlElement, names: readonly string[]): string | undefined {
  for (const name of names) {
    const lower = name.toLowerCase();
    const attribute = Object.entries(element.attributes).find(([key]) => key.toLowerCase() === lower)?.[1];
    if (clean(attribute)) return attribute;
    const child = element.children.find((c) => c.name.toLowerCase() === lower);
    if (child && clean(child.text)) return child.text;
  }
  return undefined;
}

function childSpheres(element: XmlElement): unknown {
  for (const name of FIELDS.sphereIds) {
    const child = element.children.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!child) continue;
    // <okveds><okved id="23"/><okved>45</okved></okveds> или <okveds>23,45</okveds>
    if (child.children.length > 0) return child.children.map((c) => c.attributes.id ?? c.text);
    return child.text;
  }
  return undefined;
}

/** Записи списка — дочерние элементы корня (или единственного контейнера внутри него). */
export function pageFromXml(root: XmlElement): FetchPage {
  let container = root;
  // <response><items><npa>…</npa>…</items></response>: спускаемся, пока внутри один контейнер однотипных записей.
  for (;;) {
    const only = container.children.length === 1 ? container.children[0] : undefined;
    const grand = only?.children ?? [];
    const isContainer =
      grand.length > 0 && grand.every((c) => c.name === grand[0]?.name && c.children.length > 0) && !!only;
    if (!isContainer || !only) break;
    container = only;
  }
  const entries = container.children;
  const items: NpaProject[] = [];
  for (const entry of entries) {
    const project = build({
      id: childText(entry, FIELDS.id),
      title: childText(entry, FIELDS.title),
      department: childText(entry, FIELDS.department),
      publishedAt: childText(entry, FIELDS.publishedAt),
      stage: childText(entry, FIELDS.stage),
      sphereIds: childSpheres(entry),
    });
    if (project) items.push(project);
  }
  return { items, skipped: entries.length - items.length };
}
