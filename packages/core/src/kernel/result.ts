import type { CommerceError } from "./errors.js";

export type Result<T, E = CommerceError> =
  | { ok: true; value: T; meta?: Record<string, unknown> }
  | { ok: false; error: E };

/**
 * Simplified Result types for plugin services.
 * Plugin services return `PluginResult<T>` instead of `Result<T, CommerceError>`.
 * This matches the `{ ok: true; value: T } | { ok: false; error: string }` pattern
 * that every plugin has been copy-pasting.
 */
export type PluginResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };
export type PluginResultErr = { ok: false; error: string; code?: string };

export function Ok<T>(value: T, meta?: Record<string, unknown>): Result<T, never> {
  if (meta !== undefined) {
    return { ok: true, value, meta };
  }
  return { ok: true, value };
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * String-based Err for plugin services.
 * Usage: `return PluginErr("Not found", "NOT_FOUND")`
 */
export function PluginErr(error: string, code?: string): PluginResultErr {
  return code ? { ok: false, error, code } : { ok: false, error };
}
