import type { NotificationButton } from "@max-hackathon/domain";
import { composeText } from "../../messages/shared.js";
import { encodeButtonPayload } from "../../transport/index.js";
import { homeButton } from "../checklist/index.js";
import { encodeSettingsPayload } from "./actions.js";
import type { FlowReply, NotificationSettings } from "./types.js";

// Экран настроек не пересказывает нормативные документы, поэтому вместо общей пометки K-23 «сверяйтесь
// с первоисточником» — короткое пояснение, что делают настройки.
const NOTE = "ℹ️ Настройки действуют сразу: планировщик уведомлений читает их перед каждой отправкой.";

const onOff = (value: boolean): string => (value ? "включены" : "выключены");

const settingsButtons = (settings: NotificationSettings): NotificationButton[] => {
  if (!settings.enabled) {
    return [{ text: "🔔 Включить уведомления", payload: encodeSettingsPayload("enable_all") }, homeButton()];
  }
  return [
    { text: "🔕 Отключить уведомления", payload: encodeSettingsPayload("disable_all") },
    settings.earlySignals
      ? { text: "Отключить ранние сигналы", payload: encodeSettingsPayload("disable_early") }
      : { text: "Включить ранние сигналы", payload: encodeSettingsPayload("enable_early") },
    homeButton(),
  ];
};

const describe = (settings: NotificationSettings): string[] =>
  settings.enabled
    ? [
        "Бот присылает не больше нескольких уведомлений в месяц. Когда обязанность появилась или отпала, уведомление приходит сверх лимита.",
        settings.earlySignals
          ? "Ранние сигналы — сообщения о проектах документов на regulation.gov.ru, которые могут коснуться компании."
          : "Ранние сигналы о проектах документов не приходят. Изменения действующих обязанностей приходят как обычно.",
      ]
    : ["Бот не присылает уведомления, в том числе о важных изменениях. Перечень по-прежнему доступен в меню."];

/** Экран настроек: текущие значения и кнопки, которые их меняют. */
export const renderSettings = (settings: NotificationSettings, notice?: string): FlowReply => ({
  text: composeText(
    [
      ...(notice ? [notice, ""] : []),
      "🔔 Настройки уведомлений",
      "",
      `Уведомления: ${onOff(settings.enabled)}`,
      ...(settings.enabled ? [`Ранние сигналы: ${onOff(settings.earlySignals)}`] : []),
      "",
      ...describe(settings),
    ],
    NOTE,
  ),
  sourceUrls: [],
  automated: true,
  buttons: settingsButtons(settings),
});

/** Подтверждение после сохранения. Машина K-22b переводит диалог в меню, поэтому кнопки ведут к перечню и настройкам. */
export const renderSettingsSaved = (settings: NotificationSettings): FlowReply => ({
  text: composeText(
    [
      settings.enabled ? "✅ Настройки сохранены." : "🔕 Уведомления отключены.",
      "",
      `Уведомления: ${onOff(settings.enabled)}`,
      ...(settings.enabled ? [`Ранние сигналы: ${onOff(settings.earlySignals)}`] : []),
      ...(settings.enabled ? [] : ["", "Включить их снова можно в настройках."]),
    ],
    NOTE,
  ),
  sourceUrls: [],
  automated: true,
  buttons: [
    { text: "📋 Перечень", payload: encodeButtonPayload({ type: "open_requirements" }) },
    { text: "🔔 Настройки", payload: encodeButtonPayload({ type: "open_notification_settings" }) },
  ],
});

/** Ответ, когда настройки менять не для кого: диалог ещё не знает компанию. */
export const renderSettingsNoCompany = (): FlowReply => ({
  text: composeText(["Чтобы настроить уведомления, сначала укажите ИНН компании."], NOTE),
  sourceUrls: [],
  automated: true,
  buttons: [{ text: "Ввести ИНН", payload: encodeButtonPayload({ type: "start" }) }],
  // Из idle кнопка «Ввести ИНН» (`start`) ведёт к вводу ИНН.
  stateOverride: "idle",
});
