import type { Id } from "@max-hackathon/domain";
import type {
  CoverageHistoryReader,
  CoverageHistoryWriter,
  ProfileHistorySnapshot,
  RulepackHistorySnapshot,
} from "./types.js";
import { assertIsoDate, timestamp } from "./validation.js";

const clone = <T>(value: T): T => structuredClone(value);

/** Model append-only registry. Production uses the same reader/writer ports with durable storage. */
export class MemoryCoverageHistoryRegistry implements CoverageHistoryReader, CoverageHistoryWriter {
  readonly #rulepacks: RulepackHistorySnapshot[] = [];
  readonly #profiles: ProfileHistorySnapshot[] = [];

  async appendRulepack(snapshot: RulepackHistorySnapshot): Promise<void> {
    validateRulepack(snapshot);
    const versions = this.#rulepacks.filter(({ packId }) => packId === snapshot.packId);
    if (versions.some(({ packVersion }) => packVersion === snapshot.packVersion)) {
      throw new Error(`rulepack snapshot already exists: ${snapshot.packId}@${snapshot.packVersion}`);
    }
    const latest = versions.sort((left, right) => left.packVersion - right.packVersion).at(-1);
    if (latest && snapshot.packVersion <= latest.packVersion) {
      throw new Error(`rulepack version must increase after ${snapshot.packId}@${latest.packVersion}`);
    }
    if (latest && timestamp(snapshot.publishedAt, "publishedAt") <= timestamp(latest.publishedAt, "publishedAt")) {
      throw new Error(`rulepack publishedAt must increase after ${snapshot.packId}@${latest.packVersion}`);
    }
    this.#rulepacks.push(clone(snapshot));
  }

  async appendProfile(snapshot: ProfileHistorySnapshot): Promise<void> {
    validateProfile(snapshot);
    const duplicate = this.#profiles.some(
      ({ companyId, recordedAt }) => companyId === snapshot.companyId && recordedAt === snapshot.recordedAt,
    );
    if (duplicate) throw new Error(`profile snapshot already exists: ${snapshot.companyId}@${snapshot.recordedAt}`);
    this.#profiles.push(clone(snapshot));
  }

  async listRulepacks(): Promise<RulepackHistorySnapshot[]> {
    return clone(this.#rulepacks);
  }

  async listProfiles(companyId: Id): Promise<ProfileHistorySnapshot[]> {
    return clone(this.#profiles.filter((snapshot) => snapshot.companyId === companyId));
  }
}

function validateRulepack(snapshot: RulepackHistorySnapshot): void {
  if (!snapshot.packId.trim()) throw new TypeError("packId must not be empty");
  if (!Number.isInteger(snapshot.packVersion) || snapshot.packVersion < 1) {
    throw new TypeError("packVersion must be a positive integer");
  }
  if (!snapshot.title.trim()) throw new TypeError("rulepack title must not be empty");
  if (!snapshot.owner.name.trim()) throw new TypeError("rulepack owner name must not be empty");
  if (!snapshot.source.url.trim()) throw new TypeError("rulepack source URL must not be empty");
  const publishedAt = timestamp(snapshot.publishedAt, "publishedAt");
  if (timestamp(snapshot.source.retrievedAt, "rulepack source.retrievedAt") > publishedAt) {
    throw new TypeError("rulepack source cannot be retrieved after publication");
  }
  if (snapshot.validity.from !== undefined) assertIsoDate(snapshot.validity.from, "validity.from");
  if (snapshot.validity.to !== undefined) assertIsoDate(snapshot.validity.to, "validity.to");
  if (snapshot.validity.from === undefined && snapshot.validity.to === undefined) {
    throw new TypeError("rulepack validity must have at least one boundary");
  }
  if (
    snapshot.validity.from !== undefined &&
    snapshot.validity.to !== undefined &&
    snapshot.validity.from > snapshot.validity.to
  ) {
    throw new TypeError("rulepack validity.from must not be after validity.to");
  }
  if (snapshot.requirements.length === 0) throw new TypeError("rulepack snapshot must contain requirements");
  const ids = new Set<string>();
  for (const requirement of snapshot.requirements) {
    if (requirement.packId !== snapshot.packId || requirement.packVersion !== snapshot.packVersion) {
      throw new TypeError(`requirement ${requirement.id} is outside ${snapshot.packId}@${snapshot.packVersion}`);
    }
    if (ids.has(requirement.id)) throw new TypeError(`duplicate requirement id: ${requirement.id}`);
    ids.add(requirement.id);
    if (requirement.source.isModel !== snapshot.isModel) {
      throw new TypeError(`requirement ${requirement.id} model marker differs from its rulepack`);
    }
    if (timestamp(requirement.source.retrievedAt, `requirement ${requirement.id} source.retrievedAt`) > publishedAt) {
      throw new TypeError(`requirement ${requirement.id} source cannot be retrieved after publication`);
    }
  }
  if (snapshot.source.isModel !== snapshot.isModel) {
    throw new TypeError("rulepack source model marker differs from the rulepack");
  }
}

function validateProfile(snapshot: ProfileHistorySnapshot): void {
  if (!snapshot.companyId.trim()) throw new TypeError("companyId must not be empty");
  if (snapshot.profile.companyId !== snapshot.companyId) {
    throw new TypeError(`profile company ${snapshot.profile.companyId} differs from snapshot ${snapshot.companyId}`);
  }
  const recordedAt = timestamp(snapshot.recordedAt, "recordedAt");
  if (timestamp(snapshot.profile.updatedAt, "profile.updatedAt") > recordedAt) {
    throw new TypeError("profile cannot be updated after its snapshot was recorded");
  }
  for (const fact of snapshot.profile.facts) {
    if (timestamp(fact.observedAt, `fact ${fact.id} observedAt`) > recordedAt) {
      throw new TypeError(`fact ${fact.id} cannot be observed after its profile snapshot`);
    }
    if (timestamp(fact.source.retrievedAt, `fact ${fact.id} source.retrievedAt`) > recordedAt) {
      throw new TypeError(`fact ${fact.id} source cannot be retrieved after its profile snapshot`);
    }
  }
}
