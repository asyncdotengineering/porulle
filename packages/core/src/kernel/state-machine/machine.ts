import { CommerceInvalidTransitionError } from "../errors.js";

export interface StateDefinition<TState extends string> {
  states: readonly TState[];
  initial: TState;
  transitions: Record<TState, readonly TState[]>;
  terminal: readonly TState[];
}

export type OrderState = string;

const DEFAULT_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["partially_fulfilled", "fulfilled", "cancelled"],
  partially_fulfilled: ["fulfilled", "cancelled"],
  fulfilled: ["refunded"],
  cancelled: [],
  refunded: [],
};

const DEFAULT_STATES: readonly string[] = [
  "pending", "confirmed", "processing", "partially_fulfilled",
  "fulfilled", "cancelled", "refunded",
];

const DEFAULT_TERMINAL: readonly string[] = ["cancelled", "refunded"];

export const orderStateMachine: StateDefinition<string> = {
  states: DEFAULT_STATES,
  initial: "pending",
  transitions: DEFAULT_TRANSITIONS,
  terminal: DEFAULT_TERMINAL,
};

/**
 * Extend the order state machine with custom transitions.
 * New states are added automatically. Existing state transition arrays
 * are merged (union, not replaced) with the custom ones.
 *
 * Usage:
 *   const extended = extendOrderStateMachine({
 *     pending: ["payment_initiated"],
 *     payment_initiated: ["payment_authorized", "payment_failed"],
 *     payment_authorized: ["processing"],
 *   });
 */
export function extendOrderStateMachine(
  customTransitions: Record<string, string[]>,
): StateDefinition<string> {
  const merged: Record<string, string[]> = {};

  // Copy defaults
  for (const [state, targets] of Object.entries(DEFAULT_TRANSITIONS)) {
    merged[state] = [...targets];
  }

  // Merge custom
  for (const [state, targets] of Object.entries(customTransitions)) {
    if (!merged[state]) merged[state] = [];
    for (const t of targets) {
      if (!merged[state].includes(t)) merged[state].push(t);
    }
    // Ensure target states also exist in the map
    for (const t of targets) {
      if (!merged[t]) merged[t] = [];
    }
  }

  const allStates = Object.keys(merged);
  const terminal = allStates.filter((s) => merged[s]!.length === 0);

  return {
    states: allStates,
    initial: "pending",
    transitions: merged,
    terminal,
  };
}

export function canTransition<TState extends string>(
  machine: StateDefinition<TState>,
  from: TState,
  to: TState,
): boolean {
  return machine.transitions[from].includes(to);
}

export function assertTransition<TState extends string>(
  machine: StateDefinition<TState>,
  from: TState,
  to: TState,
): void {
  if (!canTransition(machine, from, to)) {
    throw new CommerceInvalidTransitionError(
      `Cannot transition from "${from}" to "${to}". Allowed transitions from "${from}": [${machine.transitions[
        from
      ].join(", ")}]`,
    );
  }
}
