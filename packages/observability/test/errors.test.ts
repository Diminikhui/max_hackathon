import { describe, expect, it } from "vitest";
import { AppError, ERROR_DEFINITIONS, isErrorCode, toPublicError } from "../src/index.js";

describe("error taxonomy", () => {
  it("gives every known error a stable code and clear Russian user message", () => {
    for (const [code, definition] of Object.entries(ERROR_DEFINITIONS)) {
      expect(code).toMatch(/^[A-Z][A-Z_]+$/);
      expect(definition.message).toMatch(/[А-Яа-яЁё]/);
      expect(definition.message).not.toMatch(/undefined|null|stack|exception|postgres|ECONN/i);
      expect(definition.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });

  it("preserves a known code without exposing an internal cause", () => {
    const error = new AppError("DEPENDENCY_UNAVAILABLE", { cause: new Error("token=top-secret") });
    expect(toPublicError(error)).toEqual({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Внешний сервис временно недоступен. Попробуйте позже.",
      retryable: true,
    });
  });

  it("maps an unknown exception to a safe internal error", () => {
    const result = toPublicError(new Error("relation profiles does not exist"));
    expect(result).toEqual({
      code: "INTERNAL_ERROR",
      message: "Что-то пошло не так. Попробуйте позже.",
      retryable: false,
    });
  });

  it("recognizes only registered codes", () => {
    expect(isErrorCode("NOT_FOUND")).toBe(true);
    expect(isErrorCode("UNKNOWN")).toBe(false);
  });
});
