import { CommerceForbiddenError } from "../kernel/errors.js";
import type { Actor } from "./types.js";

export function hasPermission(actor: Actor | null, required: string): boolean {
  if (!actor) return false;
  if (actor.permissions.includes("*:*")) return true;

  const [resource] = required.split(":");
  if (resource && actor.permissions.includes(`${resource}:*`)) return true;
  return actor.permissions.includes(required);
}

export function assertPermission(actor: Actor | null, required: string): void {
  if (hasPermission(actor, required)) return;
  if (!actor) throw new CommerceForbiddenError("Authentication required.");

  throw new CommerceForbiddenError(
    `Permission "${required}" is required. Your role "${actor.role}" does not include this permission.`,
  );
}

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
