// K-30b. Пакеты правил, которые загружаются в хранилище при старте, и перечень с учётом модельных пакетов.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Id, ProfileRepository, Requirement, RequirementRepository } from "@max-hackathon/domain";

/** Корень репозитория: одинаков для `src/app` и `dist/app`. */
export const REPO_ROOT = join(import.meta.dirname, "../../../..");

/**
 * Пакеты сценария проверки. Реальные — направления A (общепит: федеральный, налоги и маркировка,
 * Татарстан, возможности) и B (автосервис). Модельный — `k28-model` v1: поверх него демо-кнопка K-29
 * публикует v2.
 */
export const STARTUP_RULEPACKS: readonly string[] = [
  "data/rulepacks/a/foodservice-federal-v1.json",
  "data/rulepacks/a/foodservice-tax-marking-federal-v1.json",
  "data/rulepacks/a/tatarstan/foodservice-tatarstan-v1.json",
  "data/rulepacks/a/opportunities/foodservice-opportunities-federal-v1.json",
  "data/rulepacks/b/autoservice-federal-v1.json",
  "data/fixtures/k28-rulepack-v1.json",
];

interface RulepackFile {
  readonly packId: Id;
  readonly packVersion: number;
  readonly isModel?: boolean;
  readonly requirements: Requirement[];
}

const readPack = (path: string): RulepackFile => {
  const pack = JSON.parse(readFileSync(path, "utf8")) as RulepackFile;
  if (typeof pack.packId !== "string" || !Number.isInteger(pack.packVersion) || !Array.isArray(pack.requirements)) {
    throw new Error(`Файл ${path} не похож на пакет правил`);
  }
  return pack;
};

export interface SeedReport {
  readonly installed: string[];
  readonly skipped: string[];
  /** Пакеты, помеченные модельными: реальным компаниям они не показываются. */
  readonly modelPackIds: ReadonlySet<Id>;
}

/**
 * Публикует версию пакета, если в хранилище её ещё нет. Повторный старт ничего не меняет, а более новая версия
 * (например, v2 модельного пакета после демо-кнопки) не откатывается.
 */
export const seedRulepacks = async (
  requirements: Pick<RequirementRepository, "latestVersion" | "saveVersion">,
  files: readonly string[] = STARTUP_RULEPACKS,
  root: string = REPO_ROOT,
): Promise<SeedReport> => {
  const installed: string[] = [];
  const skipped: string[] = [];
  const modelPackIds = new Set<Id>();
  for (const file of files) {
    const pack = readPack(join(root, file));
    if (pack.isModel === true) modelPackIds.add(pack.packId);
    const latest = await requirements.latestVersion(pack.packId);
    const label = `${pack.packId}@${pack.packVersion}`;
    if (latest !== undefined && latest >= pack.packVersion) {
      skipped.push(label);
      continue;
    }
    await requirements.saveVersion(pack.packId, pack.packVersion, pack.requirements);
    installed.push(label);
  }
  return { installed, skipped, modelPackIds };
};

/** Перечень K-26 с параметром отбора пакетов (форма `ChecklistService.build`). */
export interface PackAwareChecklist<Outcome> {
  build(companyId: Id, options?: { readonly packIds?: readonly Id[] }): Promise<Outcome>;
}

/**
 * Перечень для бота: модельные пакеты видят только модельные компании. Реальной компании (ИНН из реестра МСП)
 * вымышленные записи K-28 не показываются, даже если их условия выполнены.
 */
export const withModelPackBoundary = <Outcome>(
  service: PackAwareChecklist<Outcome>,
  profiles: Pick<ProfileRepository, "get">,
  requirements: Pick<RequirementRepository, "listPackIds">,
  modelPackIds: ReadonlySet<Id>,
): { build(companyId: Id): Promise<Outcome> } => ({
  async build(companyId) {
    const profile = await profiles.get(companyId);
    if (profile === undefined || profile.isModel) return service.build(companyId);
    const packIds = (await requirements.listPackIds()).filter((packId) => !modelPackIds.has(packId));
    return service.build(companyId, { packIds });
  },
});
