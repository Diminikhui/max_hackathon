import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useReducer } from "react";
import type { LaunchContext } from "./bridge";
import {
  canGoBack,
  currentRoute,
  initialStack,
  type NavigationStack,
  navigationReducer,
  type Route,
} from "./navigation";
import { openExternalLink } from "./runtime";

export interface AppContextValue {
  readonly launch: LaunchContext;
  readonly route: Route;
  readonly canGoBack: boolean;
  push(route: Route): void;
  back(): void;
  reset(route: Route): void;
  openLink(url: string): void;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ launch, children }: { launch: LaunchContext; children: ReactNode }) {
  const [stack, dispatch] = useReducer(navigationReducer, launch.startParam, initialStack);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  useBridgeBackButton(launch, stack, back);

  useEffect(() => {
    launch.bridge?.ready?.();
  }, [launch]);

  const value = useMemo<AppContextValue>(
    () => ({
      launch,
      route: currentRoute(stack),
      canGoBack: canGoBack(stack),
      push: (route) => dispatch({ type: "push", route }),
      back,
      reset: (route) => dispatch({ type: "reset", route }),
      openLink: (url) => openExternalLink(launch.bridge, url),
    }),
    [launch, stack, back],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === undefined) {
    throw new Error("useApp вызван вне AppProvider");
  }
  return value;
}

/** Синхронизирует системную кнопку «Назад» MAX со стеком экранов. */
function useBridgeBackButton(launch: LaunchContext, stack: NavigationStack, back: () => void): void {
  const button = launch.bridge?.BackButton;
  const visible = canGoBack(stack);

  useEffect(() => {
    if (!button) return;
    button.onClick(back);
    return () => button.offClick(back);
  }, [button, back]);

  useEffect(() => {
    if (!button) return;
    if (visible) button.show();
    else button.hide();
  }, [button, visible]);
}
