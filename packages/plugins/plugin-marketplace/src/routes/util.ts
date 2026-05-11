/**
 * Removes keys whose value is `undefined` from an object, returning a
 * cleaned copy that satisfies `exactOptionalPropertyTypes`.
 *
 * Zod's `.optional()` produces `T | undefined` in inferred types, which
 * can't be assigned to optional properties under `exactOptionalPropertyTypes`.
 * This helper strips those `undefined` entries at runtime and casts the
 * result so TypeScript accepts it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripUndefined<T>(obj: T): T extends Record<string, any> ? { [K in keyof T]: Exclude<T[K], undefined> } : T {
  if (obj == null || typeof obj !== "object") return obj as never;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as never;
}

/** Keys that must never be exposed in API responses. */
const VENDOR_SECRET_KEYS = [
  "storeAccessToken",
  "storeConsumerSecret",
  "storeWebhookSecret",
  "bankAccount",
] as const;

/**
 * Returns a copy of a vendor record with sensitive fields removed.
 *
 * Accepts any object with string keys so it works with both single vendor
 * rows and Drizzle `InferSelectModel` types without importing the schema.
 */
export function stripVendorSecrets<T extends Record<string, unknown>>(vendor: T): Omit<T, (typeof VENDOR_SECRET_KEYS)[number]> {
  const copy = { ...vendor };
  for (const key of VENDOR_SECRET_KEYS) {
    delete copy[key];
  }
  return copy as Omit<T, (typeof VENDOR_SECRET_KEYS)[number]>;
}
