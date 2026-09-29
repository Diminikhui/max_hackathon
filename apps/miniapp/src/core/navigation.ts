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

/**
 * Начальный стек по `start_param` deep link. Поддерживаются имена экранов (`profile`, `checklist`,
 * `settings`); неизвестное значение открывает главный экран. Разбор ссылок на конкретное требование — 2-10.
 */
export function initialStack(startParam: string | undefined): NavigationStack {
  const screen = startParam === undefined ? undefined : START_SCREENS[startParam];
  return screen === undefined ? [HOME] : [HOME, { screen }];
}

function sameRoute(a: Route, b: Route): boolean {
  if (a.screen !== b.screen) return false;
  const aParams = Object.entries(a.params ?? {});
  const bParams = b.params ?? {};
  return aParams.length === Object.keys(bParams).length && aParams.every(([key, value]) => bParams[key] === value);
}
