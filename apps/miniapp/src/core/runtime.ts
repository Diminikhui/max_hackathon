// Доступ к Bridge из браузера. Отделён от bridge.ts, чтобы разбор запуска проверялся тестами без DOM.
import type { MaxWebApp } from "./bridge";

export function getBridge(): MaxWebApp | undefined {
  return typeof window === "undefined" ? undefined : (window as { WebApp?: MaxWebApp }).WebApp;
}

/** Открывает внешнюю ссылку (первоисточник) через Bridge, вне MAX — в новой вкладке. */
export function openExternalLink(bridge: MaxWebApp | undefined, url: string): void {
  if (bridge?.openLink) {
    bridge.openLink(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
