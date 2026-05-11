import { CommerceForbiddenError } from "../kernel/errors.js";
import type { Actor } from "./types.js";

export function assertPermission(actor: Actor | null, required: string): void {
  if (!actor) {
    throw new CommerceForbiddenError("Authentication required.");
  }

  if (actor.permissions.includes("*:*")) return;

  const [resource] = required.split(":");
  if (resource && actor.permissions.includes(`${resource}:*`)) return;
  if (actor.permissions.includes(required)) return;

  throw new CommerceForbiddenError(
    `Permission "${required}" is required. Your role "${actor.role}" does not include this permission.`,
  );
}

export function assertOwnership(actor: Actor | null, resourceOwnerId: string | null): void {
  if (!actor) {
    throw new CommerceForbiddenError("Authentication required.");
  }
  if (actor.permissions.includes("*:*")) return;
  if (actor.userId !== resourceOwnerId) {
    throw new CommerceForbiddenError("You do not have access to this resource.");
  }
}
