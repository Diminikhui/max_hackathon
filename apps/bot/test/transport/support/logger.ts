import type { TransportLogger } from "../../../src/transport/index.js";

export interface RecordedLog {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;
}

export const createRecordingLogger = (): TransportLogger & { readonly records: RecordedLog[] } => {
  const records: RecordedLog[] = [];
  return {
    records,
    info: (event, _message, context) => records.push({ level: "info", event, context }),
    warn: (event, _message, context) => records.push({ level: "warn", event, context }),
    error: (event, _message, context) => records.push({ level: "error", event, context }),
  };
};
