import type { GuestOrderAccessStrategy } from "../../config/types.js";

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a window like `"7d"`, `"2h"`, `"30m"`, `"45s"`.
 * Throws at configuration time rather than silently admitting everything —
 * a typo in a security window must not read as "no limit".
 */
export function parseAccessWindow(duration: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    throw new Error(
      `Invalid guest order access window "${duration}". Use a whole number followed by s, m, h, or d — for example "7d".`,
    );
  }
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

/**
 * Grants a guest bearer credential access to a placed order for a fixed window
 * after it was placed.
 *
 * Anchored on `placedAt`, never on the cart's expiry: a shopper who checks out
 * on the sixth day of a seven-day cart would otherwise get one day of receipt
 * access. The two lifetimes are independent by construction.
 */
export function windowedGuestOrderAccess(duration: string): GuestOrderAccessStrategy {
  const windowMs = parseAccessWindow(duration);
  return {
    canAccessOrder(order, now) {
      const placedAt =
        order.placedAt instanceof Date ? order.placedAt : new Date(order.placedAt);
      const elapsed = now.getTime() - placedAt.getTime();
      return Number.isFinite(elapsed) && elapsed <= windowMs;
    },
  };
}

/**
 * The default window. Seven days matches `config.cart.ttlMinutes` so the
 * product carries one number rather than two.
 *
 * Deliberately not Vendure's two hours: that figure is calibrated for a
 * guessable order code, and a cart secret is a 122-bit random UUID. Guessing is
 * not the exposure here — a secret that leaked through a referrer, a shared
 * link or a log line is, and a bounded window is what expires it.
 */
export const defaultGuestOrderAccess: GuestOrderAccessStrategy =
  windowedGuestOrderAccess("7d");
