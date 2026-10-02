/** Whether a database error (or any error it wraps) is a Postgres unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (value.code === "23505") return true;
  return isUniqueViolation(value.cause);
}
