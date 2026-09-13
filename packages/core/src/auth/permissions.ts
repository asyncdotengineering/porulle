import {
  CommerceForbiddenError,
  CommerceUnauthorizedError,
} from "../kernel/errors.js";
import type { Actor } from "./types.js";

export const AUTHENTICATION_REQUIRED_MESSAGE = "Authentication required.";

/**
 * True when the request carried no credential at all. An API key actor
 * (`type: "api_key"`) DID present one, whatever its referenceId, so it keeps
 * 403 — telling it to authenticate would be a lie it cannot act on.
 */
export function isUnauthenticatedActor(
  actor: Pick<Actor, "type" | "userId"> | null,
): boolean {
  return actor === null || (actor.type === "user" && actor.userId === null);
}

export function hasPermission(actor: Actor | null, required: string): boolean {
  if (!actor) return false;
  if (actor.permissions.includes("*:*")) return true;

  const [resource] = required.split(":");
  if (resource && actor.permissions.includes(`${resource}:*`)) return true;
  return actor.permissions.includes(required);
}

export function assertPermission(actor: Actor | null, required: string): void {
  if (hasPermission(actor, required)) return;
  // `actor === null` is redundant at runtime — the predicate already covers it —
  // and load-bearing at compile time: a boolean predicate narrows nothing, and
  // the message below reads `actor.role`. Written this way rather than as a cast
  // so it cannot start lying if the predicate changes.
  if (actor === null || isUnauthenticatedActor(actor)) {
    throw new CommerceUnauthorizedError(AUTHENTICATION_REQUIRED_MESSAGE);
  }

  throw new CommerceForbiddenError(
    `Permission "${required}" is required. Your role "${actor.role}" does not include this permission.`,
  );
}

// NOT given the unauthenticated predicate, and the omission is deliberate.
// `auth-permissions.test.ts` pins this refusal as 403 for a STAFF actor with a
// null userId — a shape `resolveActor` cannot produce — so whether that means
// "anonymous" or "a synthetic actor whose identity is broken" has to be decided
// before the status can be. It is carded; no route reaches here with an
// anonymous actor today.
export function assertOwnership(actor: Actor | null, resourceOwnerId: string | null): void {
  if (!actor) {
    throw new CommerceForbiddenError("Authentication required.");
  }
  if (actor.permissions.includes("*:*")) return;
  if (!actor.userId || !resourceOwnerId) {
    throw new CommerceForbiddenError("You do not have access to this resource.");
  }
  if (actor.userId !== resourceOwnerId) {
    throw new CommerceForbiddenError("You do not have access to this resource.");
  }
}

/**
 * The actor's user id, for code that keys a per-person resource on it.
 *
 * An actor without a user identity — a store resolver, an API key — has no
 * owner key at all. Passing its absence through as one would make every such
 * caller look like the same person, so this refuses instead of returning a
 * value that reads as an identity.
 */
export function requireUserId(actor: Pick<Actor, "userId"> | null): string {
  if (!actor) {
    throw new CommerceForbiddenError("Authentication required.");
  }
  if (!actor.userId) {
    throw new CommerceForbiddenError("This action requires a signed-in user.");
  }
  return actor.userId;
}
