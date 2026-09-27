import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createDialogRouter, DIALOG_ROUTES } from "../../src/dialog/index.js";

const handlersReturningRoute = () =>
  Object.fromEntries(
    DIALOG_ROUTES.map((route) => [
      route,
      ({ dialogId, event, transition }) => ({ dialogId, event, transition, handledBy: route }),
    ]),
  );

describe("dialog router", () => {
  it("passes an accepted transition and original event to the selected handler", async () => {
    const router = createDialogRouter(handlersReturningRoute());
    const event = { type: "submit_inn", inn: "7700000016" };

    const routed = await router.dispatch({ dialogId: "dialog-1", state: "awaiting_inn", event });

    assert.equal(routed.transition.state, "loading_profile");
    assert.equal(routed.result.handledBy, "lookup_profile");
    assert.equal(routed.result.dialogId, "dialog-1");
    assert.equal(routed.result.event, event);
    assert.equal(routed.result.transition, routed.transition);
  });

  it("routes an invalid transition to recovery instead of dropping it", async () => {
    const router = createDialogRouter(handlersReturningRoute());

    const routed = await router.dispatch({
      dialogId: "dialog-2",
      state: "awaiting_inn",
      event: { type: "select_requirement", requirementId: "req-1" },
    });

    assert.equal(routed.transition.accepted, false);
    assert.equal(routed.transition.state, "awaiting_inn");
    assert.equal(routed.result.handledBy, "request_inn");
  });

  it("routes an obsolete persisted state through reset", async () => {
    const router = createDialogRouter(handlersReturningRoute());

    const routed = await router.dispatch({
      dialogId: "dialog-3",
      state: "old_state",
      event: { type: "start" },
    });

    assert.equal(routed.transition.state, "idle");
    assert.equal(routed.result.handledBy, "reset_dialog");
  });

  it("rejects an incomplete JavaScript handler registry explicitly", async () => {
    const router = createDialogRouter({});

    await assert.rejects(
      router.dispatch({ dialogId: "dialog-4", state: "idle", event: { type: "start" } }),
      /No dialog handler registered for route: request_inn/,
    );
  });
});
