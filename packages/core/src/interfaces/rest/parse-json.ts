import type { Context } from "hono";
import type { z } from "zod";

/**
 * A single field-level validation failure. Shape is stable across the API
 * so clients can bind form errors without ad-hoc parsing.
 */
export interface ValidationIssue {
  /** Dotted path to the offending field (e.g. "address.zip"). Empty for whole-body errors. */
  path: string;
  /** Human-readable message. */
  message: string;
  /** Machine code (zod issue code, or "invalid_json"). */
  code: string;
}

/** The error envelope's optional `details` payload. */
export interface ErrorDetails {
  issues?: ValidationIssue[];
  [key: string]: unknown;
}

/**
 * Build the uniform error envelope `{ error: { code, message, details? } }`.
 * `details` is omitted when not provided so existing responses are unchanged.
 */
export function err(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
  code: string,
  message: string,
  details?: ErrorDetails,
): Response {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    status,
  );
}

/**
 * Parse and validate a request body against a Zod schema.
 *
 * Returns the typed value on success, or a 422 `Response` (the uniform error
 * envelope, with `details.issues[]` populated from the Zod failure) that the
 * caller returns as-is. Replaces the unsafe `(await c.req.json()) as T` cast.
 *
 * ```ts
 * const body = await parseJson(c, MyBodySchema);
 * if (body instanceof Response) return body;
 * // body is z.infer<typeof MyBodySchema>
 * ```
 */
export async function parseJson<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.infer<S> | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return err(c, 422, "VALIDATION_FAILED", "Request body must be valid JSON.", {
      issues: [{ path: "", message: "Request body must be valid JSON.", code: "invalid_json" }],
    });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
      code: issue.code,
    }));
    const first = issues[0];
    const message = first
      ? `${first.path ? `${first.path}: ` : ""}${first.message}`
      : "Validation failed.";
    return err(c, 422, "VALIDATION_FAILED", message, { issues });
  }

  return result.data;
}
