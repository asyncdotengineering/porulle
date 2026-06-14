import { describe, it, expect } from "vitest";
import { isApiError, mapApiErrorToFields } from "../src/index.js";

const envelope = {
  error: {
    code: "VALIDATION_FAILED",
    message: "name: must not be empty",
    details: {
      issues: [
        { path: "name", message: "must not be empty", code: "too_small" },
        { path: "age", message: "expected number", code: "invalid_type" },
      ],
    },
  },
};

describe("SDK error helpers (#17)", () => {
  it("isApiError recognizes the envelope, a bare body, and rejects junk", () => {
    expect(isApiError(envelope)).toBe(true);
    expect(isApiError(envelope.error)).toBe(true);
    expect(isApiError({ message: "no code" })).toBe(false);
    expect(isApiError("nope")).toBe(false);
    expect(isApiError(null)).toBe(false);
  });

  it("mapApiErrorToFields flattens issues by path and exposes the form message", () => {
    const { fieldErrors, formError } = mapApiErrorToFields(envelope);
    expect(fieldErrors).toEqual({ name: "must not be empty", age: "expected number" });
    expect(formError).toBe("name: must not be empty");
  });

  it("mapApiErrorToFields handles a bare body and an error with no issues", () => {
    expect(mapApiErrorToFields(envelope.error).fieldErrors.name).toBe("must not be empty");
    const noIssues = mapApiErrorToFields({ error: { code: "FORBIDDEN", message: "nope" } });
    expect(noIssues.fieldErrors).toEqual({});
    expect(noIssues.formError).toBe("nope");
  });
});
