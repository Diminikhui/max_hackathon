// 5-05. Мониторинг событий источников и плановая перепроверка.
// Пересчёт применимости запускается двумя путями:
//   1) событием — новый ChangeEvent от источника (новая версия пакета правил, документ ленты);
//   2) по расписанию — полная перепроверка всех компаний (сроки действия записей зависят от даты `asOf`).
// Сам пересчёт и планирование уведомлений внедряются портами: монитор не дублирует правила и планировщик.
import type { ChangeEvent, ChangeEventRepository, Id } from "@max-hackathon/domain";

/** Источник событий: адаптер ленты regulation.gov.ru, публикация пакетов правил и т. п. */
export interface EventSource {
  readonly name: string;
  /** Новые события с прошлого опроса. Повторы допустимы: монитор отбрасывает уже известные по `id`. */
  poll(): Promise<ChangeEvent[]>;
}

export type RecalcTrigger = { kind: "event"; event: ChangeEvent } | { kind: "schedule"; startedAt: string };

/**
 * Пересчёт одной компании. Обычно — обёртка над `ProfileRecalculationService.recalculate`
 * (packages/services) с `changedFactKeys: []`: факты профиля не менялись, изменились правила или дата.
 */
export type RecalculateCompany = (companyId: Id, trigger: RecalcTrigger) => Promise<void>;

export interface SourceMonitorDeps {
  sources: readonly EventSource[];
  events: ChangeEventRepository;
  /** Компании для пересчёта (обычно `ProfileRepository.listCompanyIds`). */
  listCompanyIds: () => Promise<Id[]>;
  recalculate: RecalculateCompany;
  /** Передача события дальше (планировщик K-20a): например, ранний сигнал по документу ленты. */
  onEvent?: (event: ChangeEvent) => Promise<void>;
  clock?: () => Date;
}

export interface MonitorError {
  stage: "poll" | "recalculate" | "on_event";
  /** Имя источника, id компании или id события. */
  target: string;
  error: unknown;
}

export interface MonitorRunReport {
  newEvents: Id[];
  recalculated: number;
  errors: MonitorError[];
}

/** Какие события требуют пересчёта применимости. */
const needsRecalculation = (event: ChangeEvent): boolean =>
  // profile_change создаёт сам пересчёт — повторный пересчёт по нему зациклил бы монитор;
  // документ ленты ещё не меняет правила, он идёт в планировщик как ранний сигнал.
  event.kind === "rulepack_version";

export class SourceMonitor {
  readonly #deps: SourceMonitorDeps;
  readonly #clock: () => Date;

  constructor(deps: SourceMonitorDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date());
  }

  /** Опрашивает источники, сохраняет новые события и запускает по ним пересчёт. */
  async pollSources(): Promise<MonitorRunReport> {
    const report: MonitorRunReport = { newEvents: [], recalculated: 0, errors: [] };
    const fresh: ChangeEvent[] = [];
    const seen = new Set<Id>();
    for (const source of this.#deps.sources) {
      let polled: ChangeEvent[];
      try {
        polled = await source.poll();
      } catch (error) {
        report.errors.push({ stage: "poll", target: source.name, error });
        continue; // один недоступный источник не останавливает остальные
      }
      for (const event of polled) {
        if (seen.has(event.id) || (await this.#deps.events.get(event.id))) continue;
        seen.add(event.id);
        await this.#deps.events.append(event);
        fresh.push(event);
      }
    }
    fresh.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    for (const event of fresh) {
      report.newEvents.push(event.id);
      if (needsRecalculation(event)) {
        await this.#recalculateAll({ kind: "event", event }, report);
      }
      if (this.#deps.onEvent) {
        try {
          await this.#deps.onEvent(event);
        } catch (error) {
          report.errors.push({ stage: "on_event", target: event.id, error });
        }
      }
    }
    return report;
  }

  /** Плановая перепроверка всех компаний независимо от событий. */
  async recheckAll(): Promise<MonitorRunReport> {
    const report: MonitorRunReport = { newEvents: [], recalculated: 0, errors: [] };
    await this.#recalculateAll({ kind: "schedule", startedAt: this.#clock().toISOString() }, report);
    return report;
  }

  async #recalculateAll(trigger: RecalcTrigger, report: MonitorRunReport): Promise<void> {
    const companyIds = [...new Set(await this.#deps.listCompanyIds())].sort();
    for (const companyId of companyIds) {
      try {
        await this.#deps.recalculate(companyId, trigger);
        report.recalculated += 1;
      } catch (error) {
        // ошибка одной компании не прерывает остальные; следующая перепроверка повторит её
        report.errors.push({ stage: "recalculate", target: companyId, error });
      }
    }
  }
}
