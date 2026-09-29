import type { Id } from "@max-hackathon/domain";

/** Регион, региональная часть которого проверена для направления. */
export interface CoveredRegion {
  code: string;
  /** Что показала проверка, например «отличий от федеральных правил нет». */
  note: string;
  /** Региональные дополнения: показываются и датируют перечень только у компаний этого региона. */
  packIds?: readonly Id[];
}

/** Направление (отрасль), для которого есть пакет правил. */
export interface CoverageDirection {
  id: Id;
  title: string;
  /** Префиксы основного ОКВЭД, например `56` или `45.2`. */
  okvedPrefixes: readonly string[];
  /** Пакеты направления, общие для всех регионов (федеральные). Региональные — в `regions[].packIds`. */
  packIds: readonly Id[];
  /** Регионы с проверенной региональной частью; остальные — «вне покрытия». */
  regions: readonly CoveredRegion[];
}

export interface CoverageTestCompany {
  inn: string;
  title: string;
}

export interface CoverageCatalog {
  directions: readonly CoverageDirection[];
  /** Что система не проверяет ни для одного направления. */
  notChecked: readonly string[];
  /** Модельные компании для проверки сценария, если ОКВЭД вне направлений. */
  testCompanies: readonly CoverageTestCompany[];
}

/**
 * Покрытие MVP. Новый регион или направление добавляется строкой здесь вместе с пакетом:
 * регион — элементом `regions` (с региональным пакетом в его `packIds`), направление — отдельным элементом.
 */
export const DEFAULT_COVERAGE_CATALOG: CoverageCatalog = {
  directions: [
    {
      id: "a",
      title: "Общепит",
      okvedPrefixes: ["56"],
      packIds: ["a-foodservice-fed"],
      regions: [
        // K-17a: для Москвы отличий от федеральных правил не найдено (data/rulepacks/a/README.md).
        { code: "77", note: "региональных отличий от федеральных правил не найдено" },
        // K-17d: региональное дополнение data/rulepacks/a/tatarstan/ (алкоголь и энергетики).
        {
          code: "16",
          note: "региональные ограничения продажи алкоголя и энергетиков включены в перечень",
          packIds: ["a-foodservice-ru-16"],
        },
      ],
    },
    {
      id: "b",
      title: "Автосервис",
      okvedPrefixes: ["45.2"],
      packIds: ["b-autoservice-fed"],
      regions: [],
    },
  ],
  notChecked: [
    "налоги, взносы и отчётность",
    "маркировка «Честный знак»",
    "вывоз твёрдых коммунальных отходов",
    "муниципальные правила и требования арендодателя",
  ],
  testCompanies: [
    { inn: "7700000016", title: "кафе, Москва" },
    { inn: "1600000011", title: "кафе, Казань" },
    { inn: "7700000023", title: "автосервис, Москва" },
  ],
};
