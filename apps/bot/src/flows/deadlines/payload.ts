import type { NotificationButton } from "@max-hackathon/domain";

export const DEADLINES_START_PAYLOAD = "deadlines:start";
const GROUP_PREFIX = "deadlines:group:";

export type DeadlinesAction = { readonly type: "start" } | { readonly type: "group"; readonly key: string };

export const deadlinesButton = (): NotificationButton => ({
  text: "📅 Что и когда",
  payload: DEADLINES_START_PAYLOAD,
});

export const encodeDeadlineGroup = (key: string): string => `${GROUP_PREFIX}${encodeURIComponent(key)}`;

/** Чужой, пустой или повреждённый payload этот flow не перехватывает. */
export const decodeDeadlinesPayload = (payload: string): DeadlinesAction | undefined => {
  if (payload === DEADLINES_START_PAYLOAD) return { type: "start" };
  if (!payload.startsWith(GROUP_PREFIX)) return undefined;
  const encoded = payload.slice(GROUP_PREFIX.length);
  if (!encoded) return undefined;
  try {
    const key = decodeURIComponent(encoded);
    return key && encodeURIComponent(key) === encoded ? { type: "group", key } : undefined;
  } catch {
    return undefined;
  }
};
