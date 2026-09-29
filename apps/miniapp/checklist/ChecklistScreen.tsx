import { Button, CellList, CellSimple, Container, Counter, Flex, Spinner, Typography } from "@maxhub/max-ui";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../src/core/AppContext";
import { fetchChecklist } from "./api";
import "./checklist.css";
import { MODEL_CHECKLIST } from "./model";
import { filterChecklist, formatDate, STATUS_META, sourceUrl } from "./status";
import { CHECKLIST_STATUSES, type ChecklistFilter, type ChecklistItem, type CompanyChecklist } from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; checklist: CompanyChecklist; model: boolean }
  | { kind: "error"; message: string };

export function ChecklistScreen() {
  const { launch, route, openLink } = useApp();
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<ChecklistFilter>("all");
  const [selectedId, setSelectedId] = useState<string | undefined>(route.params?.requirementId);
  const [state, setState] = useState<LoadState>(() =>
    launch.inMax ? { kind: "loading" } : { kind: "ready", checklist: MODEL_CHECKLIST, model: true },
  );

  useEffect(() => {
    void reload;
    if (!launch.inMax || !launch.initData) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    fetchChecklist(launch.initData, controller.signal).then(
      (checklist) => setState({ kind: "ready", checklist, model: false }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: error instanceof Error ? error.message : "Неизвестная ошибка." });
        }
      },
    );
    return () => controller.abort();
  }, [launch.inMax, launch.initData, reload]);

  if (state.kind === "loading") {
    return (
      <Container className="checklist-state">
        <Spinner size={24} />
        <Typography.Body>Собираем перечень…</Typography.Body>
      </Container>
    );
  }
  if (state.kind === "error") {
    return (
      <Container className="checklist-state">
        <Typography.Body>{state.message}</Typography.Body>
        <Button size="medium" onClick={() => setReload((value) => value + 1)}>
          Повторить
        </Button>
      </Container>
    );
  }

  const visibleItems = filterChecklist(state.checklist.items, filter);
  return (
    <Container className="checklist-screen">
      {state.model && (
        <div className="checklist-screen__model" role="note">
          <Typography.Label>Модельный перечень для проверки экрана</Typography.Label>
        </div>
      )}
      <Typography.Body>
        Актуально на {formatDate(state.checklist.asOf)} · {state.checklist.items.length} записей
      </Typography.Body>
      <StatusFilters counts={state.checklist.statusCounts} value={filter} onChange={setFilter} />
      {visibleItems.length === 0 ? (
        <div className="checklist-screen__empty">
          <Typography.Body>В этом статусе нет требований.</Typography.Body>
        </div>
      ) : (
        <CellList mode="island" filled className="checklist-screen__list">
          {visibleItems.map((item) => (
            <RequirementCard
              key={item.requirement.id}
              item={item}
              expanded={selectedId === item.requirement.id}
              onToggle={() =>
                setSelectedId((current) => (current === item.requirement.id ? undefined : item.requirement.id))
              }
              onOpenSource={openLink}
            />
          ))}
        </CellList>
      )}
    </Container>
  );
}

function StatusFilters({
  counts,
  value,
  onChange,
}: {
  counts: CompanyChecklist["statusCounts"];
  value: ChecklistFilter;
  onChange: (filter: ChecklistFilter) => void;
}) {
  const total = useMemo(() => Object.values(counts).reduce((sum, count) => sum + count, 0), [counts]);
  return (
    <fieldset className="checklist-filters" aria-label="Фильтр по статусу">
      <FilterButton active={value === "all"} count={total} onClick={() => onChange("all")}>
        Все
      </FilterButton>
      {CHECKLIST_STATUSES.map((status) => (
        <FilterButton key={status} active={value === status} count={counts[status]} onClick={() => onChange(status)}>
          {STATUS_META[status].shortLabel}
        </FilterButton>
      ))}
    </fieldset>
  );
}

function FilterButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button size="small" variant={active ? "primary" : "secondary"} onClick={onClick} aria-pressed={active}>
      {children} <Counter value={count} variant={active ? "primary-contrast" : "mute"} />
    </Button>
  );
}

function RequirementCard({
  item,
  expanded,
  onToggle,
  onOpenSource,
}: {
  item: ChecklistItem;
  expanded: boolean;
  onToggle: () => void;
  onOpenSource: (url: string) => void;
}) {
  const meta = STATUS_META[item.applicability.status];
  const url = sourceUrl(item);
  return (
    <div className={`requirement-card requirement-card--${meta.tone}`}>
      <CellSimple
        title={item.requirement.title}
        subtitle={meta.label}
        overline={item.requirement.deadline ? `Срок: ${item.requirement.deadline}` : undefined}
        showChevron
        onClick={onToggle}
        aria-expanded={expanded}
      />
      {expanded && (
        <Flex direction="column" gap={10} className="requirement-card__details">
          {item.requirement.summary && <Typography.Body>{item.requirement.summary}</Typography.Body>}
          {item.applicability.statusReason && <Typography.Text>{item.applicability.statusReason}</Typography.Text>}
          <Typography.Label>
            Проверено {formatDate(item.applicability.evaluatedAt)} · источник получен{" "}
            {formatDate(item.requirement.source.retrievedAt)}
          </Typography.Label>
          {item.requirement.source.isModel && <Typography.Label>Модельные данные</Typography.Label>}
          {url && (
            <Button size="small" variant="secondary" onClick={() => onOpenSource(url)}>
              Открыть первоисточник
            </Button>
          )}
        </Flex>
      )}
    </div>
  );
}
