// Навигация мини-приложения: стек экранов без зависимости от React и адресной строки.
// Мини-приложение живёт в WebView MAX, поэтому «Назад» приходит из Bridge, а не из истории браузера.

export type ScreenId = "home" | "profile" | "checklist" | "settings";

export interface Route {
  readonly screen: ScreenId;
  /** Непрозрачные параметры экрана, например идентификатор требования. Без ПДн. */
  readonly params?: Readonly<Record<string, string>>;
}

export type NavigationAction =
  | { readonly type: "push"; readonly route: Route }
  | { readonly type: "back" }
  | { readonly type: "reset"; readonly route: Route };

export type NavigationStack = readonly [Route, ...Route[]];

export const HOME: Route = { screen: "home" };

export function navigationReducer(stack: NavigationStack, action: NavigationAction): NavigationStack {
  switch (action.type) {
    case "push": {
      const top = currentRoute(stack);
      return sameRoute(top, action.route) ? stack : [...stack, action.route];
    }
    case "back":
      return stack.length > 1 ? (stack.slice(0, -1) as unknown as NavigationStack) : stack;
    case "reset":
      return action.route.screen === "home" ? [action.route] : [HOME, action.route];
  }
}

export function currentRoute(stack: NavigationStack): Route {
  return stack[stack.length - 1] ?? stack[0];
}

export function canGoBack(stack: NavigationStack): boolean {
  return stack.length > 1;
}

const START_SCREENS: Readonly<Record<string, ScreenId>> = {
  profile: "profile",
  checklist: "checklist",
  settings: "settings",
};

const REQUIREMENT_START_PREFIX = "requirement_";

/** Декодирует непрозрачный UTF-8 hex payload кнопки `open_app`; некорректные значения игнорируются. */
export function requirementIdFromStartParam(startParam: string): string | undefined {
  if (!startParam.startsWith(REQUIREMENT_START_PREFIX)) return undefined;
  const encoded = startParam.slice(REQUIREMENT_START_PREFIX.length);
  if (encoded.length === 0 || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) return undefined;
  try {
    const bytes = Uint8Array.from(encoded.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
    const requirementId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return requirementId.length > 0 ? requirementId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Начальный стек по `start_param` deep link. Поддерживаются имена экранов (`profile`, `checklist`,
 * `settings`) и непрозрачная ссылка на требование; неизвестное значение открывает главный экран.
 */
export function initialStack(startParam: string | undefined): NavigationStack {
  const screen = startParam === undefined ? undefined : START_SCREENS[startParam];
  if (screen !== undefined) return [HOME, { screen }];
  const requirementId = startParam === undefined ? undefined : requirementIdFromStartParam(startParam);
  return requirementId === undefined ? [HOME] : [HOME, { screen: "checklist", params: { requirementId } }];
}

function sameRoute(a: Route, b: Route): boolean {
  if (a.screen !== b.screen) return false;
  const aParams = Object.entries(a.params ?? {});
  const bParams = b.params ?? {};
  return aParams.length === Object.keys(bParams).length && aParams.every(([key, value]) => bParams[key] === value);
}
