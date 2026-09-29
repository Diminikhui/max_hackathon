// Типизированная обёртка над MAX Bridge (`window.WebApp`, скрипт https://st.max.ru/js/max-web-app.js).
// Описаны только поля и методы, нужные MVP: https://dev.max.ru/docs/webapps/bridge
import type { PlatformType } from "@maxhub/max-ui";

export type MaxPlatform = "ios" | "android" | "desktop" | "web";

export interface MaxBackButton {
  readonly isVisible?: boolean;
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

export interface MaxWebApp {
  // Вне клиента MAX скрипт Bridge всё равно создаёт `window.WebApp`, но поля равны `null`.
  readonly initData?: string | null;
  readonly initDataUnsafe?: { readonly start_param?: string | null } | null;
  readonly platform?: string | null;
  readonly version?: string | null;
  readonly BackButton?: MaxBackButton;
  ready?(): void;
  close?(): void;
  openLink?(url: string): void;
  openMaxLink?(url: string): void;
}

export interface LaunchContext {
  /** Приложение открыто в клиенте MAX: Bridge есть и передал подписанный `initData`. */
  readonly inMax: boolean;
  /** Bridge клиента MAX; вне MAX — `undefined`, даже если скрипт Bridge загружен. */
  readonly bridge: MaxWebApp | undefined;
  readonly platform: MaxPlatform | undefined;
  /** Платформа для MAX UI; `undefined` — провайдер определит сам. */
  readonly uiPlatform: PlatformType | undefined;
  /**
   * `start_param` из deep link. Только для выбора экрана: доверять значению можно
   * лишь после серверной проверки `initData` (2-01b).
   */
  readonly startParam: string | undefined;
  /** Строка для серверной проверки подписи; на клиенте не разбирается. */
  readonly initData: string | undefined;
}

const PLATFORMS: readonly MaxPlatform[] = ["ios", "android", "desktop", "web"];
// Формат payload deep link по документации MAX: до 512 символов [A-Za-z0-9_-].
const START_PARAM = /^[A-Za-z0-9_-]{1,512}$/;

export function readLaunchContext(bridge: MaxWebApp | undefined): LaunchContext {
  const initData = nonEmpty(bridge?.initData);
  const platform = PLATFORMS.find((p) => p === bridge?.platform);
  const startParam = nonEmpty(bridge?.initDataUnsafe?.start_param);
  const inMax = initData !== undefined;
  return {
    inMax,
    bridge: inMax ? bridge : undefined,
    platform,
    uiPlatform: platform === "ios" || platform === "android" ? platform : undefined,
    startParam: startParam !== undefined && START_PARAM.test(startParam) ? startParam : undefined,
    initData,
  };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
