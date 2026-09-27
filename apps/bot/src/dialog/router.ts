import { transitionDialog } from "./machine.js";
import type { DialogEvent, DialogRouteHandler, DialogRouteHandlers, RoutedDialogResult } from "./types.js";

export interface DialogRouter<Result> {
  dispatch(input: {
    readonly dialogId: string;
    readonly state: string;
    readonly event: DialogEvent;
  }): Promise<RoutedDialogResult<Result>>;
}

/** Routes an event through the pure machine and invokes exactly one scenario handler. */
export const createDialogRouter = <Result>(handlers: DialogRouteHandlers<Result>): DialogRouter<Result> => ({
  async dispatch({ dialogId, state, event }) {
    const transition = transitionDialog(state, event);
    const handler: DialogRouteHandler<Result> | undefined = handlers[transition.route];

    // Keeps JavaScript consumers from silently dropping a newly added route.
    if (handler === undefined) {
      throw new Error(`No dialog handler registered for route: ${transition.route}`);
    }

    const result = await handler({ dialogId, event, transition });
    return { transition, result };
  },
});
