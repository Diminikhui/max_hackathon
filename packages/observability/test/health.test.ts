import { describe, expect, it } from "vitest";
import { checkHealth } from "../src/index.js";

const fixedNow = () => new Date("2026-09-25T09:00:00.000Z");
const zeroDuration = () => 10;

describe("health checks", () => {
  it("is healthy when all checks pass", async () => {
    await expect(
      checkHealth(
        [
          { name: "database", check: () => true },
          { name: "requirements-source", critical: false, check: async () => true },
        ],
        { now: fixedNow, monotonicNow: zeroDuration },
      ),
    ).resolves.toEqual({
      status: "healthy",
      checkedAt: "2026-09-25T09:00:00.000Z",
      checks: [
        { name: "database", status: "up", critical: true, durationMs: 0 },
        { name: "requirements-source", status: "up", critical: false, durationMs: 0 },
      ],
    });
  });

  it("is degraded when only an optional dependency is down", async () => {
    const report = await checkHealth([{ name: "optional-model", critical: false, check: () => false }]);
    expect(report.status).toBe("degraded");
    expect(report.checks[0]).toMatchObject({ status: "down", message: "Проверка не пройдена" });
  });

  it("is unhealthy when a critical dependency throws and hides its error", async () => {
    const report = await checkHealth([
      { name: "database", check: () => Promise.reject(new Error("postgres://user:password@host/db")) },
    ]);
    expect(report.status).toBe("unhealthy");
    expect(JSON.stringify(report)).not.toContain("password");
    expect(report.checks[0]).toMatchObject({ status: "down", message: "Проверка недоступна" });
  });

  it("times out a hanging check", async () => {
    const report = await checkHealth([
      { name: "upstream", timeoutMs: 5, check: () => new Promise<boolean>(() => undefined) },
    ]);
    expect(report.status).toBe("unhealthy");
    expect(report.checks[0]?.status).toBe("down");
  });

  it("runs checks in parallel", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const waitForGate = async (): Promise<boolean> => {
      started++;
      await gate;
      return true;
    };
    const promise = checkHealth([
      { name: "one", check: waitForGate },
      { name: "two", check: waitForGate },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(2);
    release?.();
    await expect(promise).resolves.toMatchObject({ status: "healthy" });
  });
});
