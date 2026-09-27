// Общие модельные фикстуры тестов пересчёта (2-09): профиль, требования и in-memory порты.
import {
  type ApplicabilityRepository,
  type ApplicabilityResult,
  type ChangeEvent,
  type ChangeEventRepository,
  CONTRACT_VERSION,
  type CompanyProfile,
  FACT_KEYS,
  type ProfileRepository,
  type Requirement,
  type RequirementRepository,
} from "@max-hackathon/domain";
import type { RecalculationLease, RecalculationState, RecalculationStateRepository } from "../../src/recalc/index.js";

export const NOW = "2026-09-26T08:00:00Z";
export const source = { system: "model-fixture", retrievedAt: NOW, isModel: true } as const;

export const profile = (okved: string, size: string, updatedAt = NOW): CompanyProfile => ({
  contractVersion: CONTRACT_VERSION,
  companyId: "company:model-1",
  inn: "7700000016",
  entityType: "legal_entity",
  isModel: true,
  updatedAt,
  facts: [
    {
      id: "fact:okved",
      companyId: "company:model-1",
      key: FACT_KEYS.okvedMain,
      value: okved,
      kind: "official",
      source,
      observedAt: NOW,
    },
    {
      id: "fact:size",
      companyId: "company:model-1",
      key: FACT_KEYS.mspCategory,
      value: size,
      kind: "official",
      source,
      observedAt: NOW,
    },
  ],
});

export const requirement = (id: string, condition: Requirement["condition"]): Requirement => ({
  contractVersion: CONTRACT_VERSION,
  id,
  packId: "pack:model",
  packVersion: 1,
  kind: "obligation",
  title: id,
  basis: [{ act: "Модельный нормативный акт", url: "https://example.invalid/model" }],
  condition,
  coverage: "full",
  source,
});

export class MemoryProfiles implements ProfileRepository {
  constructor(public value: CompanyProfile) {}
  async get(): Promise<CompanyProfile | undefined> {
    return this.value;
  }
  async findByInn(): Promise<CompanyProfile | undefined> {
    return this.value;
  }
  async save(value: CompanyProfile) {
    this.value = value;
  }
  async addFacts() {}
  async listCompanyIds() {
    return [this.value.companyId];
  }
}

export class MemoryRequirements implements RequirementRepository {
  constructor(readonly records: Requirement[]) {}
  async listByPack(_packId: string, version?: number) {
    return version === 1 ? this.records : [];
  }
  async latestVersion() {
    return 1;
  }
  async listPackIds() {
    return ["pack:model"];
  }
  async saveVersion() {}
}

export class MemoryApplicability implements ApplicabilityRepository {
  value: ApplicabilityResult[] = [];
  failNextReplace = false;
  async listByCompany() {
    return structuredClone(this.value);
  }
  async replaceForCompany(_companyId: string, results: ApplicabilityResult[]) {
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("model snapshot store unavailable");
    }
    this.value = structuredClone(results);
  }
}

export class MemoryEvents implements ChangeEventRepository {
  readonly values: ChangeEvent[] = [];
  failNextAppend = false;
  async append(event: ChangeEvent) {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("model event store unavailable");
    }
    if (!this.values.some((item) => item.id === event.id)) this.values.push(event);
  }
  async get(id: string) {
    return this.values.find((item) => item.id === id);
  }
}

/** In-memory аренда и состояние: та же семантика, что у PostgresRecalculationStateRepository. */
export class MemoryRecalculationState implements RecalculationStateRepository {
  readonly values = new Map<string, RecalculationState>();
  readonly leases = new Map<string, { token: string; expiresAt: number }>();
  now = () => Date.now();
  #next = 0;
  async acquire(companyId: string, ttlMs: number) {
    const current = this.leases.get(companyId);
    if (current && current.expiresAt > this.now()) return undefined;
    const token = `lease-${++this.#next}`;
    this.leases.set(companyId, { token, expiresAt: this.now() + ttlMs });
    return { token };
  }
  async release(companyId: string, lease: RecalculationLease) {
    if (this.leases.get(companyId)?.token === lease.token) this.leases.delete(companyId);
  }
  async get(companyId: string) {
    const value = this.values.get(companyId);
    return value ? structuredClone(value) : undefined;
  }
  async save(companyId: string, lease: RecalculationLease, state: RecalculationState) {
    const current = this.leases.get(companyId);
    if (current?.token !== lease.token || current.expiresAt <= this.now()) return false;
    this.values.set(companyId, structuredClone(state));
    return true;
  }
}
