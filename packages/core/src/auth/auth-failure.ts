/**
 * Separates a credential better-auth evaluated and rejected from an auth check
 * that failed to run. Only the first justifies telling a caller their
 * credential is bad; the second is a fault and must surface as one.
 *
 * Matched structurally rather than with `instanceof APIError`. A cross-copy
 * `instanceof` is false whenever two better-auth copies are resolved into one
 * tree — which is precisely the fault this predicate has to stay honest about.
 * `kernel/error-mapper.ts` reads `constructor?.name` for the same reason.
 *
 * better-call's `APIError` carries `name === "APIError"` and a numeric
 * `statusCode`; its `status` is a string such as `"UNAUTHORIZED"`.
 */
export function isCredentialRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, statusCode } = err as { name?: unknown; statusCode?: unknown };
  return name === "APIError" && typeof statusCode === "number";
}
