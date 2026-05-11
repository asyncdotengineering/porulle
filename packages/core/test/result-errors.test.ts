import { describe, expect, it } from "vitest";
import { Err, Ok } from "../src/kernel/result.js";
import { mapErrorToStatus } from "../src/kernel/error-mapper.js";
import {
  CommerceConflictError,
  CommerceForbiddenError,
  CommerceInvalidTransitionError,
  CommerceNotFoundError,
  CommerceValidationError,
} from "../src/kernel/errors.js";

describe("Result type", () => {
  it("creates Ok and Err variants", () => {
    const ok = Ok({ id: "1" });
    const err = Err(new CommerceNotFoundError("missing"));

    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
  });
});

describe("error mapper", () => {
  it("maps known error codes to statuses", () => {
    expect(mapErrorToStatus(new CommerceNotFoundError("x"))).toBe(404);
    expect(mapErrorToStatus(new CommerceValidationError("x"))).toBe(422);
    expect(mapErrorToStatus(new CommerceForbiddenError("x"))).toBe(403);
    expect(mapErrorToStatus(new CommerceConflictError("x"))).toBe(409);
    expect(mapErrorToStatus(new CommerceInvalidTransitionError("x"))).toBe(422);
  });
});
