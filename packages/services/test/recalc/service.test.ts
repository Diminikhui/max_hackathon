import { FACT_KEYS } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { ProfileRecalculationService, RecalculationBusyError } from "../../src/recalc/index.js";
import {
  MemoryApplicability,
  MemoryEvents,
  MemoryProfiles,
  MemoryRecalculationState,
  MemoryRequirements,
  NOW,
  profile,
  requirement,
} from "./support.js";

const setupDeps = (state: ReturnType<typeof setup>) => ({
  profiles: state.profiles,
  requirements: state.requirements,
  applicability: state.applicability,
  events: state.events,
  recalculationState: state.recalculationState,
  clock: () => NOW,
});

const setup = () => {
  const profiles = new MemoryProfiles(profile("47.11", "micro"));
  const applicability = new MemoryApplicability();
  const events = new MemoryEvents();
  const recalculationState = new MemoryRecalculationState();
  const requirements = new MemoryRequirements([
    requirement("req:food", { type: "okved_prefix", prefix: "56" }),
    requirement("req:small", { type: "msp_category", in: ["small"] }),
  ]);
  const service = new ProfileRecalculationService({
    profiles,
    requirements,
    applicability,
    events,
    recalculationState,
    clock: () => NOW,
  });
  return { profiles, requirements, applicability, events, recalculationState, service };
};

describe("ProfileRecalculationService", () => {
  it("даёт дельту появилось/исчезло при смене ОКВЭД и размера и публикует модельное событие", async () => {
    const state = setup();
    await state.service.recalculate("company:model-1", { changedFactKeys: [] });
    state.profiles.value = profile("56.10", "small");

    const result = await state.service.recalculate("company:model-1", {
      changedFactKeys: [FACT_KEYS.mspCategory, FACT_KEYS.okvedMain, FACT_KEYS.okvedMain],
      eventId: () => "event:profile-change-1",
    });

    expect(result.status).toBe("changed");
    if (result.status !== "changed") throw new Error("expected changed");
    expect(result.delta.appeared.map((item) => item.requirementId)).toEqual(["req:food", "req:small"]);
    expect(result.delta.disappeared).toEqual([]);
    expect(result.event).toMatchObject({
      id: "event:profile-change-1",
      kind: "profile_change",
      isModel: true,
      profile: { companyId: "company:model-1", changedFactKeys: [FACT_KEYS.okvedMain, FACT_KEYS.mspCategory] },
    });

    state.profiles.value = profile("47.11", "micro");
    const reversed = await state.service.recalculate("company:model-1", {
      changedFactKeys: [FACT_KEYS.okvedMain, FACT_KEYS.mspCategory],
      eventId: () => "event:profile-change-2",
    });
    if (reversed.status === "profile_not_found") throw new Error("expected recalculation");
    expect(reversed.delta.disappeared.map((item) => item.requirementId)).toEqual(["req:food", "req:small"]);
  });

  it("повторный пересчёт идемпотентен: обновляет снимок, но не создаёт событие без дельты", async () => {
    const state = setup();
    const first = await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });
    const second = await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });

    expect(first.status).toBe("unchanged");
    expect(second).toMatchObject({ status: "unchanged", delta: { appeared: [], disappeared: [] } });
    expect(state.events.values).toHaveLength(0);
    expect(state.applicability.value).toHaveLength(2);
  });

  it("после failed append повтор сохраняет один event и корректный снимок", async () => {
    const state = setup();
    state.profiles.value = profile("56.10", "small");
    state.events.failNextAppend = true;
    const options = { changedFactKeys: [FACT_KEYS.okvedMain, FACT_KEYS.mspCategory] };

    await expect(state.service.recalculate("company:model-1", options)).rejects.toThrow(
      "model event store unavailable",
    );
    expect(state.applicability.value).toEqual([]);
    expect(state.events.values).toEqual([]);

    const retried = await state.service.recalculate("company:model-1", options);

    expect(retried.status).toBe("changed");
    expect(state.events.values).toHaveLength(1);
    expect(state.applicability.value.map((item) => item.requirementId)).toEqual(["req:food", "req:small"]);
  });

  it("после successful append + failed replace retry не дублирует event", async () => {
    const state = setup();
    const times = ["2026-09-26T08:01:00Z", "2026-09-26T08:02:00Z"];
    const service = new ProfileRecalculationService({
      profiles: state.profiles,
      requirements: new MemoryRequirements([
        requirement("req:food", { type: "okved_prefix", prefix: "56" }),
        requirement("req:small", { type: "msp_category", in: ["small"] }),
      ]),
      applicability: state.applicability,
      events: state.events,
      recalculationState: state.recalculationState,
      clock: () => times.shift() ?? "2026-09-26T08:03:00Z",
    });
    state.profiles.value = profile("56.10", "small", "2026-09-26T08:00:30Z");
    state.applicability.failNextReplace = true;

    await expect(service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] })).rejects.toThrow(
      "model snapshot store unavailable",
    );
    expect(state.events.values).toHaveLength(1);
    const firstEvent = structuredClone(state.events.values[0]);

    const retried = await service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });

    expect(retried.status).toBe("changed");
    expect(state.events.values).toEqual([firstEvent]);
    expect(state.applicability.value[0]?.evaluatedAt).toBe("2026-09-26T08:02:00Z");
  });

  it("не подавляет одинаковые по значениям и timestamps переходы после цикла A→B→A→B", async () => {
    const state = setup();
    state.profiles.value = profile("56.10", "small", NOW);
    await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });
    const firstForwardId = state.events.values[0]?.id;

    state.profiles.value = profile("47.11", "micro", NOW);
    await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });
    state.profiles.value = profile("56.10", "small", NOW);
    await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });

    expect(state.events.values).toHaveLength(3);
    expect(state.events.values[2]?.id).not.toBe(firstForwardId);
  });

  it("возвращает profile_not_found и не меняет снимок", async () => {
    const state = setup();
    state.profiles.get = async () => undefined;
    await expect(state.service.recalculate("missing", { changedFactKeys: [] })).resolves.toEqual({
      status: "profile_not_found",
      companyId: "missing",
    });
    expect(state.applicability.value).toEqual([]);
  });

  it("после snapshot success + сбой фиксации ревизии retry не дублирует event и не теряет переход", async () => {
    const state = setup();
    state.profiles.value = profile("56.10", "small");
    const save = state.recalculationState.save.bind(state.recalculationState);
    let failCommit = true;
    state.recalculationState.save = async (companyId, lease, next) => {
      if (failCommit && next.pending === undefined && next.committedRevision === 1) {
        failCommit = false;
        throw new Error("model state store unavailable");
      }
      return save(companyId, lease, next);
    };

    await expect(state.service.recalculate("company:model-1", { changedFactKeys: [] })).rejects.toThrow(
      "model state store unavailable",
    );
    expect(state.events.values).toHaveLength(1);
    expect((await state.recalculationState.get("company:model-1"))?.pending?.revision).toBe(1);

    const retried = await state.service.recalculate("company:model-1", { changedFactKeys: [] });
    expect(retried.status).toBe("changed");
    expect(state.events.values).toHaveLength(1);
    expect(await state.recalculationState.get("company:model-1")).toEqual({ committedRevision: 2 });
  });

  it("доигрывает чужую pending-операцию и затем применяет собственное изменение профиля", async () => {
    const state = setup();
    state.profiles.value = profile("56.10", "small");
    state.applicability.failNextReplace = true;
    await expect(state.service.recalculate("company:model-1", { changedFactKeys: [] })).rejects.toThrow();

    state.profiles.value = profile("47.11", "micro");
    const result = await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });

    expect(result.status).toBe("changed");
    if (result.status !== "changed") throw new Error("expected changed");
    expect(result.delta.disappeared.map((item) => item.requirementId)).toEqual(["req:food", "req:small"]);
    expect(state.events.values).toHaveLength(2);
    expect(state.applicability.value.every((item) => item.status !== "applies")).toBe(true);
  });

  it("два одновременных пересчёта одной компании выполняются по очереди и дают по событию на переход", async () => {
    const state = setup();
    await state.service.recalculate("company:model-1", { changedFactKeys: [] });
    state.profiles.value = profile("56.10", "small");
    const service = new ProfileRecalculationService({
      ...setupDeps(state),
      leaseRetryMs: 1,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });

    const results = await Promise.all([
      service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] }),
      service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] }),
    ]);

    expect(results.map((item) => item.status).sort()).toEqual(["changed", "unchanged"]);
    expect(state.events.values).toHaveLength(1);
    expect(await state.recalculationState.get("company:model-1")).toEqual({ committedRevision: 3 });
  });

  it("занятая компания даёт RecalculationBusyError после ожидания, истёкшая аренда перехватывается", async () => {
    const state = setup();
    let now = 0;
    state.recalculationState.now = () => now;
    await state.recalculationState.acquire("company:model-1", 1_000);
    const service = new ProfileRecalculationService({
      ...setupDeps(state),
      leaseWaitMs: 20,
      leaseRetryMs: 10,
      sleep: async () => {},
    });

    await expect(service.recalculate("company:model-1", { changedFactKeys: [] })).rejects.toBeInstanceOf(
      RecalculationBusyError,
    );
    now = 1_000;
    await expect(service.recalculate("company:model-1", { changedFactKeys: [] })).resolves.toMatchObject({
      status: "unchanged",
    });
  });

  it("потерянная аренда не даёт зафиксировать результат", async () => {
    const state = setup();
    state.profiles.value = profile("56.10", "small");
    state.events.append = async () => {
      state.recalculationState.leases.clear();
      await state.recalculationState.acquire("company:model-1", 60_000);
    };
    await expect(state.service.recalculate("company:model-1", { changedFactKeys: [] })).rejects.toThrow("потеряна");
    expect((await state.recalculationState.get("company:model-1"))?.committedRevision).toBe(0);
  });
});
