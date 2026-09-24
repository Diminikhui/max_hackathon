// Порты адаптеров и хранилища v1. Реализации живут в packages/adapters и packages/storage;
// потоки волны 1 работают против этих интерфейсов и подменяют их в тестах.

import type {
  ApplicabilityResult,
  ChangeEvent,
  CompanyProfile,
  Fact,
  Id,
  Notification,
  NotificationCandidate,
  NotificationStatus,
  Requirement,
} from "./contracts.js";

/** Описание реализации порта: для модельных реализаций `isModel = true`. */
export interface SourceInfo {
  name: string;
  isModel: boolean;
}

export type ProfileLookupResult =
  | { status: "found"; profile: CompanyProfile }
  | { status: "not_found" }
  | { status: "unavailable"; errorCode: string; retryable: boolean };

/** Источник профиля компании по ИНН: fixture (K-11), ЕГРЮЛ (K-12a), реестр МСП (K-12b). */
export interface ProfileSource {
  readonly info: SourceInfo;
  lookupByInn(inn: string): Promise<ProfileLookupResult>;
}

export interface RequirementQuery {
  /** Префиксы ОКВЭД, например `["56"]`. */
  okvedPrefixes?: string[];
  regionCodes?: string[];
}

/** Источник требований: fixture (K-13a), ФГИС РОТ (K-13b), КНД и ЕРКНМ (K-13c). */
export interface RequirementSource {
  readonly info: SourceInfo;
  listRequirements(query: RequirementQuery): Promise<Requirement[]>;
}

/** Профили и факты (K-10a). Заявленный факт не заменяет официальный. */
export interface ProfileRepository {
  get(companyId: Id): Promise<CompanyProfile | undefined>;
  findByInn(inn: string): Promise<CompanyProfile | undefined>;
  save(profile: CompanyProfile): Promise<void>;
  addFacts(companyId: Id, facts: Fact[]): Promise<void>;
  listCompanyIds(): Promise<Id[]>;
}

/** Записи пакетов правил по версиям (K-10b). Формат пакета целиком задаёт K-15b. */
export interface RequirementRepository {
  /** Без `version` — последняя опубликованная версия пакета. */
  listByPack(packId: Id, version?: number): Promise<Requirement[]>;
  latestVersion(packId: Id): Promise<number | undefined>;
  listPackIds(): Promise<Id[]>;
  saveVersion(packId: Id, version: number, requirements: Requirement[]): Promise<void>;
}

/** Последние вычисленные результаты — для расчёта дельты при пересчёте. */
export interface ApplicabilityRepository {
  listByCompany(companyId: Id): Promise<ApplicabilityResult[]>;
  replaceForCompany(companyId: Id, results: ApplicabilityResult[]): Promise<void>;
}

/** События изменений (K-10c). */
export interface ChangeEventRepository {
  append(event: ChangeEvent): Promise<void>;
  get(id: Id): Promise<ChangeEvent | undefined>;
}

/** Кандидаты и уведомления со статусом доставки (K-10c). */
export interface NotificationRepository {
  saveCandidate(candidate: NotificationCandidate): Promise<void>;
  /** Есть ли уже кандидат с таким dedupKey у компании. */
  hasCandidate(companyId: Id, dedupKey: string): Promise<boolean>;
  enqueue(notification: Notification): Promise<void>;
  findByIdempotencyKey(key: string): Promise<Notification | undefined>;
  listQueued(limit: number): Promise<Notification[]>;
  updateStatus(
    id: Id,
    update: { status: NotificationStatus; attempts: number; sentAt?: string; error?: Notification["error"] },
  ): Promise<void>;
}
