import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  orderStateMachine,
} from "../src/kernel/state-machine/machine.js";
import { CommerceInvalidTransitionError } from "../src/kernel/errors.js";

describe("order state machine", () => {
  it("accepts valid transitions", () => {
    expect(canTransition(orderStateMachine, "pending", "confirmed")).toBe(true);
    expect(canTransition(orderStateMachine, "processing", "fulfilled")).toBe(true);
  });

  it("throws on invalid transitions", () => {
    expect(() =>
      assertTransition(orderStateMachine, "pending", "fulfilled"),
    ).toThrow(CommerceInvalidTransitionError);
  });

  it("terminal states reject transitions", () => {
    expect(canTransition(orderStateMachine, "cancelled", "pending")).toBe(false);
    expect(canTransition(orderStateMachine, "refunded", "processing")).toBe(false);
  });
});
