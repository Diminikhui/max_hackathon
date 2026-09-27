export const DIALOG_STATES = [
  "idle",
  "awaiting_inn",
  "loading_profile",
  "confirming_profile",
  "menu",
  "requirement_list",
  "requirement_details",
  "notification_settings",
] as const;

export type DialogState = (typeof DIALOG_STATES)[number];

export type DialogEvent =
  | { readonly type: "start" }
  | { readonly type: "submit_inn"; readonly inn: string }
  | { readonly type: "profile_loaded"; readonly profileId: string }
  | { readonly type: "profile_not_found" }
  | { readonly type: "profile_lookup_failed"; readonly retryable: boolean }
  | { readonly type: "confirm_profile" }
  | { readonly type: "edit_profile" }
  | { readonly type: "open_requirements" }
  | { readonly type: "select_requirement"; readonly requirementId: string }
  | { readonly type: "open_notification_settings" }
  | { readonly type: "notification_settings_saved" }
  | { readonly type: "back" }
  | { readonly type: "home" };

export type DialogEventType = DialogEvent["type"];

export const DIALOG_ROUTES = [
  "show_welcome",
  "request_inn",
  "lookup_profile",
  "confirm_profile",
  "profile_not_found",
  "profile_lookup_failed",
  "show_menu",
  "show_requirement_list",
  "show_requirement_details",
  "show_notification_settings",
  "notification_settings_saved",
  "recover_current",
  "reset_dialog",
] as const;

export type DialogRoute = (typeof DIALOG_ROUTES)[number];

export interface DialogTransition {
  readonly previousState: string;
  readonly state: DialogState;
  readonly route: DialogRoute;
  readonly accepted: boolean;
  /** Events that can make progress from the resulting state. */
  readonly allowedEvents: readonly DialogEventType[];
  readonly reason?: "invalid_transition" | "unknown_state";
}

export interface DialogRouteContext {
  readonly dialogId: string;
  readonly event: DialogEvent;
  readonly transition: DialogTransition;
}

export type DialogRouteHandler<Result> = (context: DialogRouteContext) => Result | Promise<Result>;

export type DialogRouteHandlers<Result> = {
  readonly [Route in DialogRoute]: DialogRouteHandler<Result>;
};

export interface RoutedDialogResult<Result> {
  readonly transition: DialogTransition;
  readonly result: Result;
}
