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
