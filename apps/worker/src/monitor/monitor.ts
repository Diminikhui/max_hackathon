// 5-05. Мониторинг событий источников и плановая перепроверка.
// Единый путь событий «новая версия пакета правил» (#295):
//   - событие rulepack_version создаёт только контур уведомлений K-30a (`rulepacks`). Он же рассылает
//     уведомления и обновляет снимки применимости; монитор вызывает его в начале каждого опроса и перед
//     перепроверкой, поэтому перепроверка не увидит новую версию пакета раньше контура;
//   - rulepack_version от других источников отклоняется: второй путь дал бы второй пересчёт и расхождение id;
//   - плановая перепроверка пересчитывает все компании (сроки действия записей зависят от даты `asOf`).
// Остальные события (документы ленты, profile_change) передаются дальше через `onEvent` без пересчёта.
// Сам пересчёт и планирование уведомлений внедряются портами: монитор не дублирует правила и планировщик.
import type { ChangeEvent, ChangeEventRepository, Id } from "@max-hackathon/domain";

/** Источник событий: адаптер ленты regulation.gov.ru и т. п. Версии пакетов правил сюда не входят. */
export interface EventSource {
  readonly name: string;
  /** Новые события с прошлого опроса. Повторы допустимы: монитор отбрасывает уже известные по `id`. */
  poll(): Promise<ChangeEvent[]>;
}

export type RecalcTrigger = { kind: "schedule"; startedAt: string };

/**
 * Пересчёт одной компании. Обычно — обёртка над `ProfileRecalculationService.recalculate`
 * (packages/services) с `changedFactKeys: []`: факты профиля не менялись, изменилась дата.
 */
export type RecalculateCompany = (companyId: Id, trigger: RecalcTrigger) => Promise<void>;

export interface SourceMonitorDeps {
  sources: readonly EventSource[];
  events: ChangeEventRepository;
  /** Компании для пересчёта (обычно `ProfileRepository.listCompanyIds`). */
  listCompanyIds: () => Promise<Id[]>;
  recalculate: RecalculateCompany;
  /**
   * Контур пакетов правил K-30a — единственный источник rulepack_version:
   * обычно `() => runRulepackNotifications({ …, snapshots })` из `../notify`.
   */
  rulepacks?: () => Promise<unknown>;
  /** Передача события дальше (планировщик K-20a): например, ранний сигнал по документу ленты. */
  onEvent?: (event: ChangeEvent) => Promise<void>;
  clock?: () => Date;
}

export interface MonitorError {
  stage: "rulepacks" | "poll" | "recalculate" | "on_event";
  /** Имя источника, id компании или id события. */
  target: string;
  error: unknown;
}

export interface MonitorRunReport {
  newEvents: Id[];
  recalculated: number;
  errors: MonitorError[];
}

export class SourceMonitor {
  readonly #deps: SourceMonitorDeps;
  readonly #clock: () => Date;

  constructor(deps: SourceMonitorDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date());
  }

  /**
   * Прогоняет контур пакетов правил, опрашивает источники и передаёт новые события дальше.
   * Событие записывается ПОСЛЕ успешной передачи: при сбое `onEvent` оно не считается известным и будет
   * обработано снова, если источник его повторит (адаптеры лент отдают окно, а не только новое).
   */
  async pollSources(): Promise<MonitorRunReport> {
    const report: MonitorRunReport = { newEvents: [], recalculated: 0, errors: [] };
    await this.#runRulepacks(report);
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
        if (event.kind === "rulepack_version") {
          report.errors.push({
            stage: "poll",
            target: source.name,
            error: new Error(`rulepack_version создаёт только контур K-30a: событие ${event.id} отклонено`),
          });
          continue;
        }
        if (seen.has(event.id) || (await this.#deps.events.get(event.id))) continue;
        seen.add(event.id);
        fresh.push(event);
      }
    }
    fresh.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    for (const event of fresh) {
      if (this.#deps.onEvent) {
        try {
          await this.#deps.onEvent(event);
        } catch (error) {
          report.errors.push({ stage: "on_event", target: event.id, error });
          continue;
        }
      }
      await this.#deps.events.append(event);
      report.newEvents.push(event.id);
    }
    return report;
  }

  /**
   * Плановая перепроверка всех компаний. Сначала — контур пакетов правил; если он упал, перепроверка
   * не выполняется: иначе она отнесла бы необработанный переход пакета к `profile_change` и дала бы
   * второе уведомление. Цикл повторит её на следующем тике.
   */
  async recheckAll(): Promise<MonitorRunReport> {
    const report: MonitorRunReport = { newEvents: [], recalculated: 0, errors: [] };
    if (!(await this.#runRulepacks(report))) return report;
    await this.#recalculateAll({ kind: "schedule", startedAt: this.#clock().toISOString() }, report);
    return report;
  }

  async #runRulepacks(report: MonitorRunReport): Promise<boolean> {
    if (!this.#deps.rulepacks) return true;
    try {
      await this.#deps.rulepacks();
      return true;
    } catch (error) {
      report.errors.push({ stage: "rulepacks", target: "rulepacks", error });
      return false;
    }
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
