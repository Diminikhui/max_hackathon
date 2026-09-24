import { describe, expect, it } from "vitest";
import { createJsonLogSink, createLogger, REDACTED, sanitizeLogContext } from "../src/index.js";

describe("safe structured logging", () => {
  it("redacts secret and personal-data fields recursively without mutating input", () => {
    const context = {
      requestId: "req-42",
      authorization: "Bearer very-secret",
      company: { inn: "7700000016", displayName: "Модельное кафе", okved: "56.10" },
      actor: { chatId: "123456789012", email: "owner@example.test" },
    };
    const sanitized = sanitizeLogContext(context);

    expect(sanitized).toEqual({
      requestId: "req-42",
      authorization: REDACTED,
      company: { inn: REDACTED, displayName: "Модельное кафе", okved: "56.10" },
      actor: { chatId: REDACTED, email: REDACTED },
    });
    expect(context.company.inn).toBe("7700000016");
  });

  it("redacts common secrets and PII embedded in messages and arrays", () => {
    const sanitized = sanitizeLogContext({
      values: [
        "Bearer abc.def-123",
        "owner@example.test",
        "+7 (999) 123-45-67",
        "ИНН 7700000016",
        "https://example.test/callback?token=secret-value&state=ok",
      ],
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/abc\.def|owner@|999|7700000016|secret-value/);
  });

  it("sanitizes Error objects, circular values and bigint", () => {
    const circular: Record<string, unknown> = { id: 42n };
    circular.self = circular;
    const sanitized = sanitizeLogContext({
      error: Object.assign(new Error("request for 7700000016 failed"), { code: "UPSTREAM_FAILED" }),
      circular,
    });
    expect(sanitized).toEqual({
      error: { name: "Error", message: `request for ${REDACTED} failed`, code: "UPSTREAM_FAILED" },
      circular: { id: "42", self: "[CIRCULAR]" },
    });
  });

  it("creates deterministic records and cleans the top-level message", () => {
    const records: unknown[] = [];
    const logger = createLogger(
      (record) => records.push(record),
      () => new Date("2026-09-25T09:00:00.000Z"),
    );
    logger.warn("profile.lookup", "Lookup for owner@example.test failed", { requestId: "req-42" });
    expect(records).toEqual([
      {
        timestamp: "2026-09-25T09:00:00.000Z",
        level: "warn",
        event: "profile.lookup",
        message: `Lookup for ${REDACTED} failed`,
        context: { requestId: "req-42" },
      },
    ]);
  });

  it("serializes one JSON line through an injected writer", () => {
    const lines: string[] = [];
    createJsonLogSink((line) => lines.push(line))({
      timestamp: "2026-09-25T09:00:00.000Z",
      level: "info",
      event: "service.started",
      message: "ready",
      context: {},
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "service.started", level: "info" });
  });
});
