import { CHECKLIST_STATUSES, type CompanyChecklist } from "./types";

export class ChecklistApiError extends Error {
  constructor(readonly status: number) {
    super(status === 503 ? "Вход временно недоступен." : "Не удалось загрузить перечень.");
  }
}

export async function fetchChecklist(initData: string, signal?: AbortSignal): Promise<CompanyChecklist> {
  const sessionResponse = await fetch("/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
    signal,
  });
  if (!sessionResponse.ok) throw new ChecklistApiError(sessionResponse.status);
  const session = (await sessionResponse.json()) as { token: string };
  const checklistResponse = await fetch("/api/v1/checklist", {
    headers: { authorization: `Bearer ${session.token}` },
    signal,
  });
  if (!checklistResponse.ok) throw new ChecklistApiError(checklistResponse.status);
  const checklist: unknown = await checklistResponse.json();
  if (!isChecklist(checklist)) throw new ChecklistApiError(502);
  return checklist;
}

function isChecklist(value: unknown): value is CompanyChecklist {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CompanyChecklist>;
  if (!Array.isArray(candidate.items) || !candidate.statusCounts) return false;
  return CHECKLIST_STATUSES.every(
    (status) => Number.isInteger(candidate.statusCounts?.[status]) && (candidate.statusCounts?.[status] ?? -1) >= 0,
  );
}
