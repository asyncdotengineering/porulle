import { CommerceInvalidTransitionError } from "../errors.js";

export interface StateDefinition<TState extends string> {
  states: readonly TState[];
  initial: TState;
  /**
   * The states an entity may be CREATED in, as opposed to reach by transition.
   *
   * `states` is not this set and must never be used as it: it contains `fulfilled`, `refunded` and
   * `cancelled`, so validating creation against it would let a caller create an order past its
   * entire lifecycle — no transition recorded, no status-change hook fired, nothing to audit.
   * `initial` alone is too narrow in the other direction: a hosted-redirect gateway produces an
   * order that exists and is not yet paid, and that order must not spend a moment looking like a
   * healthy `pending` one.
   */
  initialStates: readonly TState[];
  transitions: Record<TState, readonly TState[]>;
  terminal: readonly TState[];
}

export type OrderState = string;

const DEFAULT_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["confirmed", "cancelled"],
  // An order that exists but is not yet paid. Every hosted-redirect gateway produces one: the
  // shopper has been sent to the gateway and nothing is owed to a merchant yet. It is a core
  // state rather than something each application re-invents, because the alternative is every
  // consumer inventing a different name for the same thing.
  //
  // There is no `expired`. An expiry is a cancellation carrying a reason, and `changeStatus`
  // already carries one; a second terminal meaning "cancelled, but by a clock" would cost every
  // query, filter and report a second name to remember for one outcome.
  pending_payment: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["partially_fulfilled", "fulfilled", "cancelled"],
  partially_fulfilled: ["fulfilled", "cancelled"],
  fulfilled: ["refunded"],
  cancelled: [],
  refunded: [],
};

const DEFAULT_STATES: readonly string[] = [
  "pending", "pending_payment", "confirmed", "processing", "partially_fulfilled",
  "fulfilled", "cancelled", "refunded",
];

/** The two ways an order may begin: paid-on-arrival, or awaiting a gateway. */
const DEFAULT_INITIAL_STATES: readonly string[] = ["pending", "pending_payment"];

const DEFAULT_TERMINAL: readonly string[] = ["cancelled", "refunded"];

export const orderStateMachine: StateDefinition<string> = {
  states: DEFAULT_STATES,
  initial: "pending",
  initialStates: DEFAULT_INITIAL_STATES,
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
    // A custom transition adds states an order may REACH, never one it may start in — that would
    // let `customTransitions` quietly widen what can be created. An application that needs a new
    // starting point declares it deliberately, not as a side effect of describing a transition.
    initialStates: DEFAULT_INITIAL_STATES.filter((state) => allStates.includes(state)),
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
