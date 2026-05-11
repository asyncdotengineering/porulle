import type { Actor } from "../../auth/types.js";
import type { Cart } from "./repository/index.js";

/**
 * Determines whether an actor can access a cart.
 *
 * Access is granted if:
 * 1. The actor is authenticated and owns the cart (customerId match)
 * 2. The provided secret matches the cart's secret (guest access)
 */
export function canAccessCart(
  actor: Actor | null,
  cart: Cart,
  providedSecret?: string,
): boolean {
  // Authenticated owner
  if (actor && cart.customerId && actor.userId === cart.customerId) {
    return true;
  }

  // Valid secret (guest access)
  if (providedSecret && cart.secret && providedSecret === cart.secret) {
    return true;
  }

  return false;
}
