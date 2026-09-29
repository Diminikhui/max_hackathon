import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { allowedDialogEvents, DIALOG_STATES, transitionDialog } from "../../src/dialog/index.js";

const transitions = [
  ["idle", { type: "start" }, "awaiting_inn", "request_inn"],
  ["idle", { type: "home" }, "idle", "show_welcome"],
  ["awaiting_inn", { type: "submit_inn", inn: "7700000016" }, "loading_profile", "lookup_profile"],
  ["awaiting_inn", { type: "home" }, "idle", "show_welcome"],
  ["loading_profile", { type: "profile_loaded", profileId: "profile-1" }, "confirming_profile", "confirm_profile"],
  ["loading_profile", { type: "profile_not_found" }, "awaiting_inn", "profile_not_found"],
  ["loading_profile", { type: "profile_lookup_failed", retryable: true }, "awaiting_inn", "profile_lookup_failed"],
  ["loading_profile", { type: "home" }, "idle", "show_welcome"],
  ["confirming_profile", { type: "confirm_profile" }, "menu", "show_menu"],
  ["confirming_profile", { type: "edit_profile" }, "awaiting_inn", "request_inn"],
  ["confirming_profile", { type: "home" }, "idle", "show_welcome"],
  ["menu", { type: "open_requirements" }, "requirement_list", "show_requirement_list"],
  ["menu", { type: "open_notification_settings" }, "notification_settings", "show_notification_settings"],
  ["menu", { type: "edit_profile" }, "awaiting_inn", "request_inn"],
  ["menu", { type: "home" }, "menu", "show_menu"],
  [
    "requirement_list",
    { type: "select_requirement", requirementId: "req-1" },
    "requirement_details",
    "show_requirement_details",
  ],
  ["requirement_list", { type: "back" }, "menu", "show_menu"],
  ["requirement_list", { type: "home" }, "menu", "show_menu"],
  ["requirement_details", { type: "back" }, "requirement_list", "show_requirement_list"],
  ["requirement_details", { type: "open_requirements" }, "requirement_list", "show_requirement_list"],
  ["requirement_details", { type: "home" }, "menu", "show_menu"],
  ["notification_settings", { type: "notification_settings_saved" }, "menu", "notification_settings_saved"],
  ["notification_settings", { type: "back" }, "menu", "show_menu"],
  ["notification_settings", { type: "home" }, "menu", "show_menu"],
];

describe("dialog state machine", () => {
  for (const [from, event, to, route] of transitions) {
    it(`${from} + ${event.type} -> ${to}`, () => {
      const result = transitionDialog(from, event);

      assert.equal(result.accepted, true);
      assert.equal(result.previousState, from);
      assert.equal(result.state, to);
      assert.equal(result.route, route);
      assert.equal(result.reason, undefined);
      assert.ok(result.allowedEvents.length > 0);
    });
  }

  for (const state of DIALOG_STATES) {
    it(`recovers from an unsupported event in ${state}`, () => {
      const validTypes = allowedDialogEvents(state);
      const invalidEvent = transitions.map((item) => item[1]).find((event) => !validTypes.includes(event.type));
      assert.ok(invalidEvent, `test setup must find an invalid event for ${state}`);

      const result = transitionDialog(state, invalidEvent);

      assert.equal(result.accepted, false);
      assert.equal(result.state, state);
      assert.equal(result.reason, "invalid_transition");
      assert.ok(result.allowedEvents.length > 0);
      assert.deepEqual(result.allowedEvents, validTypes);
    });
  }

  it("resets an unknown persisted state to a usable initial state", () => {
    const result = transitionDialog("removed_state_from_old_release", { type: "back" });

    assert.deepEqual(result, {
      previousState: "removed_state_from_old_release",
      state: "idle",
      route: "reset_dialog",
      accepted: false,
      allowedEvents: ["start", "home"],
      reason: "unknown_state",
    });
  });

  for (const state of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
    it(`resets prototype key "${state}" instead of treating it as a state`, () => {
      const result = transitionDialog(state, { type: "back" });
      assert.equal(result.state, "idle");
      assert.equal(result.route, "reset_dialog");
      assert.equal(result.reason, "unknown_state");
    });
  }
});
