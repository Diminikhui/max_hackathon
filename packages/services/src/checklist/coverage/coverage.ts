// K-34. Что проверяется и что нет: направление по ОКВЭД, региональная часть, дата актуальности пакетов.
import type { CompanyProfile, Id, IsoDate } from "@max-hackathon/domain";
import type { CompanyChecklist } from "../service.js";
import { type CoverageCatalog, type CoverageTestCompany, DEFAULT_COVERAGE_CATALOG } from "./catalog.js";
import { regionName } from "./regions.js";

export interface CoveragePack {
  packId: Id;
  packVersion: number;
  /** Самая поздняя дата ручной проверки записей пакета (`source.retrievedAt`). */
  checkedAt?: IsoDate;
}

export type DirectionCoverage =
  | { status: "covered"; id: Id; title: string }
  /** ОКВЭД известен, но ни одного пакета для него нет. */
  | { status: "outside_directions"; okvedMain: string }
  /** В профиле нет основного ОКВЭД. */
  | { status: "unknown_okved" };

export type RegionalCoverage =
  | { status: "covered"; code: string; name: string; note: string }
  /** Федеральные записи показаны, региональные требования этого региона не проверялись. */
  | { status: "out_of_coverage"; code: string; name: string }
  | { status: "unknown_region" };

export interface CoverageReport {
  companyId: Id;
  asOf: IsoDate;
  isModel: boolean;
  direction: DirectionCoverage;
  /** Для направления вне покрытия не заполняется: региональная часть не имеет смысла. */
  regional?: RegionalCoverage;
  /** Пакеты направления, участвовавшие в перечне. */
  packs: CoveragePack[];
  /** Дата актуальности: самая поздняя проверка среди пакетов направления. */
  actualAt?: IsoDate;
  /** Число записей, которые применяются или требуют проверки/данных. */
  relevantItemCount: number;
  notChecked: readonly string[];
  /** Заполняется, когда направление не покрыто: чем проверить сценарий. */
  testCompanies?: readonly CoverageTestCompany[];
}

const factValue = (profile: CompanyProfile, key: string): unknown => profile.facts.find((fact) => fact.key === key)?.value;

/** `45.2` покрывает `45.20` и `45.21`; `56` — `56.10`, но не `560`. */
export const matchesOkved = (okved: string, prefix: string): boolean =>
  okved === prefix || okved.startsWith(prefix.includes(".") ? prefix : `${prefix}.`);

const latestDate = (dates: readonly string[]): IsoDate | undefined =>
  dates.length === 0 ? undefined : dates.map((value) => value.slice(0, 10)).sort().at(-1);

/** Строит отчёт о покрытии по профилю и уже построенному перечню (K-26). */
export const describeCoverage = (
  profile: CompanyProfile,
  checklist: CompanyChecklist,
  catalog: CoverageCatalog = DEFAULT_COVERAGE_CATALOG,
): CoverageReport => {
  const okved = factValue(profile, "activity.okved_main");
  const rawRegion = factValue(profile, "location.region_code");
  const regionCode = typeof rawRegion === "string" && rawRegion.trim() !== "" ? rawRegion.trim().padStart(2, "0") : undefined;
  const matched =
    typeof okved === "string"
      ? catalog.directions.find((direction) => direction.okvedPrefixes.some((prefix) => matchesOkved(okved, prefix)))
      : undefined;

  const base = {
    companyId: checklist.companyId,
    asOf: checklist.asOf,
    isModel: profile.isModel,
    notChecked: catalog.notChecked,
    relevantItemCount: checklist.items.filter(
      (item) => item.applicability.status !== "not_applies" && item.applicability.status !== "out_of_coverage",
    ).length,
  };

  if (!matched) {
    return {
      ...base,
      direction: typeof okved === "string" ? { status: "outside_directions", okvedMain: okved } : { status: "unknown_okved" },
      packs: [],
      testCompanies: catalog.testCompanies,
    };
  }

  const packs: CoveragePack[] = checklist.packs
    .filter((pack) => matched.packIds.includes(pack.packId))
    .map((pack) => {
      const checkedAt = latestDate(
        checklist.items
          .filter((item) => item.requirement.packId === pack.packId)
          .map((item) => item.requirement.source.retrievedAt),
      );
      return { packId: pack.packId, packVersion: pack.packVersion, ...(checkedAt ? { checkedAt } : {}) };
    });
  const actualAt = latestDate(packs.flatMap((pack) => (pack.checkedAt ? [pack.checkedAt] : [])));

  let regional: RegionalCoverage = { status: "unknown_region" };
  if (regionCode) {
    const covered = matched.regions.find((region) => region.code === regionCode);
    regional = covered
      ? { status: "covered", code: regionCode, name: regionName(regionCode), note: covered.note }
      : { status: "out_of_coverage", code: regionCode, name: regionName(regionCode) };
  }

  return {
    ...base,
    direction: { status: "covered", id: matched.id, title: matched.title },
    regional,
    packs,
    ...(actualAt ? { actualAt } : {}),
  };
};
