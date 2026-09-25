import type { DialogEvent, DialogEventType, DialogRoute, DialogState, DialogTransition } from "./types.js";

interface TransitionDefinition {
  readonly state: DialogState;
  readonly route: DialogRoute;
}

type StateTransitions = Readonly<Partial<Record<DialogEventType, TransitionDefinition>>>;

const TRANSITIONS = {
  idle: {
    start: { state: "awaiting_inn", route: "request_inn" },
    home: { state: "idle", route: "show_welcome" },
  },
  awaiting_inn: {
    submit_inn: { state: "loading_profile", route: "lookup_profile" },
    home: { state: "idle", route: "show_welcome" },
  },
  loading_profile: {
    profile_loaded: { state: "confirming_profile", route: "confirm_profile" },
    profile_not_found: { state: "awaiting_inn", route: "profile_not_found" },
    profile_lookup_failed: { state: "awaiting_inn", route: "profile_lookup_failed" },
    home: { state: "idle", route: "show_welcome" },
  },
  confirming_profile: {
    confirm_profile: { state: "menu", route: "show_menu" },
    edit_profile: { state: "awaiting_inn", route: "request_inn" },
    home: { state: "idle", route: "show_welcome" },
  },
  menu: {
    open_requirements: { state: "requirement_list", route: "show_requirement_list" },
    open_notification_settings: {
      state: "notification_settings",
      route: "show_notification_settings",
    },
    home: { state: "menu", route: "show_menu" },
  },
  requirement_list: {
    select_requirement: {
      state: "requirement_details",
      route: "show_requirement_details",
    },
    back: { state: "menu", route: "show_menu" },
    home: { state: "menu", route: "show_menu" },
  },
  requirement_details: {
    back: { state: "requirement_list", route: "show_requirement_list" },
    open_requirements: {
      state: "requirement_list",
      route: "show_requirement_list",
    },
    home: { state: "menu", route: "show_menu" },
  },
  notification_settings: {
    notification_settings_saved: {
      state: "menu",
      route: "notification_settings_saved",
    },
    back: { state: "menu", route: "show_menu" },
    home: { state: "menu", route: "show_menu" },
  },
} as const satisfies Readonly<Record<DialogState, StateTransitions>>;

const RECOVERY_ROUTES = {
  idle: "show_welcome",
  awaiting_inn: "request_inn",
  loading_profile: "recover_current",
  confirming_profile: "confirm_profile",
  menu: "show_menu",
  requirement_list: "show_requirement_list",
  requirement_details: "recover_current",
  notification_settings: "show_notification_settings",
} as const satisfies Readonly<Record<DialogState, DialogRoute>>;

const isDialogState = (state: string): state is DialogState => state in TRANSITIONS;

const allowedEventsFor = (state: DialogState): readonly DialogEventType[] =>
  Object.freeze(Object.keys(TRANSITIONS[state]) as DialogEventType[]);

/**
 * Pure state transition. Unknown persisted states are reset to `idle`; unsupported
 * events re-render the current step, so user input can never leave a dialog stuck.
 */
export const transitionDialog = (currentState: string, event: DialogEvent): DialogTransition => {
  if (!isDialogState(currentState)) {
    return {
      previousState: currentState,
      state: "idle",
      route: "reset_dialog",
      accepted: false,
      allowedEvents: allowedEventsFor("idle"),
      reason: "unknown_state",
    };
  }

  const stateTransitions: StateTransitions = TRANSITIONS[currentState];
  const definition = stateTransitions[event.type];

  if (definition === undefined) {
    return {
      previousState: currentState,
      state: currentState,
      route: RECOVERY_ROUTES[currentState],
      accepted: false,
      allowedEvents: allowedEventsFor(currentState),
      reason: "invalid_transition",
    };
  }

  return {
    previousState: currentState,
    state: definition.state,
    route: definition.route,
    accepted: true,
    allowedEvents: allowedEventsFor(definition.state),
  };
};

export const allowedDialogEvents = (state: DialogState): readonly DialogEventType[] => allowedEventsFor(state);
