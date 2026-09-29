import type { DialogEvent, DialogRouteContext, DialogRouteHandler, RoutedDialogResult } from "../../dialog/index.js";
import { applySettingsAction } from "./actions.js";
import { renderSettings, renderSettingsNoCompany, renderSettingsSaved } from "./render.js";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type FlowReply,
  type NotificationSettingsStore,
  type SettingsAction,
} from "./types.js";

export interface SettingsFlowDeps {
  readonly settings: NotificationSettingsStore;
  /** Компания, привязанная к диалогу после онбординга (K-24a). `undefined` — ИНН ещё не введён. */
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
}

export interface SettingsFlowHandlers {
  readonly show_notification_settings: DialogRouteHandler<FlowReply>;
  readonly notification_settings_saved: DialogRouteHandler<FlowReply>;
}

/** Часть роутера K-22b, которая нужна для сохранения: `createDialogRouter` подходит без переходника. */
export interface SettingsRouter {
  dispatch(input: {
    readonly dialogId: string;
    readonly state: string;
    readonly event: DialogEvent;
  }): Promise<RoutedDialogResult<FlowReply>>;
}

export interface SettingsFlow {
  /** Обработчики маршрутов для `createDialogRouter`. */
  readonly handlers: SettingsFlowHandlers;
  /**
   * Нажатие кнопки настроек (`decodeSettingsPayload`). Сохраняет итоговые настройки и проводит через машину диалога
   * системное событие `notification_settings_saved`. Сохранённое состояние диалога — `transition.state`
   * или `result.stateOverride`, как у остальных сценариев.
   */
  handleAction(input: {
    readonly router: SettingsRouter;
    readonly dialogId: string;
    readonly action: SettingsAction;
  }): Promise<RoutedDialogResult<FlowReply>>;
}

export const createSettingsFlow = ({ settings, companyOf }: SettingsFlowDeps): SettingsFlow => {
  const current = async (companyId: string) => (await settings.settingsFor(companyId)) ?? DEFAULT_NOTIFICATION_SETTINGS;

  const show = async ({ dialogId }: DialogRouteContext): Promise<FlowReply> => {
    const companyId = await companyOf(dialogId);
    if (companyId === undefined) return renderSettingsNoCompany();
    return renderSettings(await current(companyId));
  };

  const saved = async ({ dialogId }: DialogRouteContext): Promise<FlowReply> => {
    const companyId = await companyOf(dialogId);
    if (companyId === undefined) return renderSettingsNoCompany();
    return renderSettingsSaved(await current(companyId));
  };

  const handleAction: SettingsFlow["handleAction"] = async ({ router, dialogId, action }) => {
    const companyId = await companyOf(dialogId);
    if (companyId !== undefined) {
      await settings.save(companyId, applySettingsAction(await settings.settingsFor(companyId), action));
    }
    // Кнопка есть только на экране настроек, поэтому событие проводится из `notification_settings`, даже если
    // пользователь нажал её в старом сообщении: отключение должно срабатывать всегда. Без компании обработчик
    // `notification_settings_saved` предложит ввести ИНН.
    return router.dispatch({
      dialogId,
      state: "notification_settings",
      event: { type: "notification_settings_saved" },
    });
  };

  return {
    handlers: { show_notification_settings: show, notification_settings_saved: saved },
    handleAction,
  };
};

/** Хранилище в памяти процесса: для тестов и демо до подключения базы данных. */
export const createMemorySettingsStore = (
  initial: Iterable<readonly [string, { enabled: boolean; earlySignals: boolean }]> = [],
): NotificationSettingsStore => {
  const byCompany = new Map(initial);
  return {
    settingsFor: async (companyId) => {
      const value = byCompany.get(companyId);
      return value === undefined ? undefined : { ...value };
    },
    save: async (companyId, value) => {
      byCompany.set(companyId, { enabled: value.enabled, earlySignals: value.earlySignals });
    },
  };
};
