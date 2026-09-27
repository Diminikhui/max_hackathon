// K-30a: событие «вышла новая версия пакета правил» и сопоставление его с профилями.
// Статусы до и после считаются одним вычислителем (K-16) по одному профилю и одной дате,
// поэтому уведомление вызывает только изменение пакета, а не изменение фактов.

import {
  type ApplicabilityStatus,
  type ChangeEvent,
  CONTRACT_VERSION,
  type CompanyProfile,
  type DateTime,
  type Id,
  type IsoDate,
  type Requirement,
  type RequirementRepository,
  type RulepackChange,
} from "@max-hackathon/domain";
import { assessRequirement, decisiveLeaves } from "@max-hackathon/rules";
import type { ApplicabilityMatch, ProfileMatcher } from "../planner/match/index.js";

/** Две соседние опубликованные версии пакета и разница между ними. */
export interface RulepackTransition {
  change: RulepackChange;
  from: Requirement[];
  to: Requirement[];
  isModel: boolean;
}

/** Идентификатор события устойчив: повторный прогон того же перехода даёт то же событие. */
export const rulepackEventId = (change: Pick<RulepackChange, "packId" | "fromVersion" | "toVersion">): Id =>
  `rulepack_version:${change.packId}:${change.fromVersion ?? 0}->${change.toVersion}`;

/** Содержимое записи без полей версии: одинаковая запись в двух версиях не считается изменённой. */
const content = (requirement: Requirement): string => {
  const { packVersion: _version, source, ...rest } = requirement;
  const { retrievedAt: _retrievedAt, ...stableSource } = source;
  return JSON.stringify({ ...rest, source: stableSource });
};

const byId = (requirements: readonly Requirement[]): Map<Id, Requirement> =>
  new Map(requirements.map((requirement) => [requirement.id, requirement]));

/**
 * Переход с предыдущей опубликованной версии на последнюю. Первая публикация пакета перехода не даёт:
 * о первоначальном перечне компания узнаёт при онбординге, а не уведомлением о каждой записи.
 */
export const latestTransition = async (
  requirements: Pick<RequirementRepository, "latestVersion" | "listByPack">,
  packId: Id,
): Promise<RulepackTransition | undefined> => {
  const toVersion = await requirements.latestVersion(packId);
  if (toVersion === undefined) return undefined;

  let fromVersion = toVersion - 1;
  let from: Requirement[] = [];
  for (; fromVersion >= 1; fromVersion -= 1) {
    from = await requirements.listByPack(packId, fromVersion);
    if (from.length > 0) break;
  }
  if (fromVersion < 1) return undefined;

  const to = await requirements.listByPack(packId, toVersion);
  const before = byId(from);
  const after = byId(to);
  const sorted = (ids: Iterable<Id>) => [...ids].sort();

  return {
    change: {
      packId,
      fromVersion,
      toVersion,
      addedRequirementIds: sorted([...after.keys()].filter((id) => !before.has(id))),
      changedRequirementIds: sorted(
        [...after.entries()]
          .filter(([id, item]) => {
            const previous = before.get(id);
            return previous !== undefined && content(previous) !== content(item);
          })
          .map(([id]) => id),
      ),
      removedRequirementIds: sorted([...before.keys()].filter((id) => !after.has(id))),
    },
    from,
    to,
    isModel: [...from, ...to].some((item) => item.source.isModel),
  };
};

export const rulepackEvent = (transition: RulepackTransition, occurredAt: DateTime): ChangeEvent => ({
  contractVersion: CONTRACT_VERSION,
  id: rulepackEventId(transition.change),
  kind: "rulepack_version",
  occurredAt,
  isModel: transition.isModel,
  rulepack: structuredClone(transition.change),
});

/** Изменилась ли версия так, что уведомлять вообще есть о чём. */
export const hasRequirementChanges = ({ change }: RulepackTransition): boolean =>
  change.addedRequirementIds.length + change.changedRequirementIds.length + change.removedRequirementIds.length > 0;

export interface RulepackMatcherOptions {
  evaluatedAt: DateTime;
  asOf?: IsoDate;
}

/**
 * Сопоставитель для планировщика K-20a. Удалённая из пакета запись для компании больше «не применяется»:
 * отдельного статуса для отменённой нормы в контракте v1 нет.
 */
export const rulepackMatcher = (transition: RulepackTransition, options: RulepackMatcherOptions): ProfileMatcher => {
  const before = byId(transition.from);
  const after = byId(transition.to);
  const { change } = transition;
  const ids = [...change.addedRequirementIds, ...change.changedRequirementIds, ...change.removedRequirementIds];
  const assessOptions = { evaluatedAt: options.evaluatedAt, ...(options.asOf ? { asOf: options.asOf } : {}) };

  return (_event, profile: CompanyProfile) =>
    ids.map((requirementId): ApplicabilityMatch => {
      const previous = before.get(requirementId);
      const next = after.get(requirementId);
      const previousResult = previous && assessRequirement(previous, profile, assessOptions);
      const nextResult = next && assessRequirement(next, profile, assessOptions);
      const newStatus: ApplicabilityStatus = nextResult?.status ?? "not_applies";
      const trace = nextResult?.trace ?? previousResult?.trace;
      return {
        kind: "applicability",
        requirementId,
        ...(previousResult ? { previousStatus: previousResult.status } : {}),
        newStatus,
        matchedFactKeys: trace ? decisiveLeaves(trace).flatMap(({ node }) => node.factKeys) : [],
      };
    });
};
