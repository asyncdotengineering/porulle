/**
 * Client-side helpers for the uniform API error envelope.
 *
 * The server returns `{ error: { code, message, details?: { issues[] } } }`.
 * `openapi-fetch` surfaces that body as the `error` field of a result, or it
 * may arrive as a thrown value. These helpers normalize either shape so forms
 * can bind field errors without ad-hoc parsing.
 */

export interface ValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: { issues?: ValidationIssue[]; [key: string]: unknown };
}

/** Pull the inner error body out of an envelope, a bare body, or a thrown wrapper. */
function extractErrorBody(e: unknown): ApiErrorBody | undefined {
  if (!e || typeof e !== "object") return undefined;
  const obj = e as Record<string, unknown>;

  // Full envelope: { error: { code, message, details } }
  if (obj.error && typeof obj.error === "object") {
    const inner = obj.error as Record<string, unknown>;
    if (typeof inner.code === "string" && typeof inner.message === "string") {
      return inner as unknown as ApiErrorBody;
    }
  }

  // Bare body: { code, message, details }
  if (typeof obj.code === "string" && typeof obj.message === "string") {
    return obj as unknown as ApiErrorBody;
  }

  // Thrown wrapper exposing the body on common fields.
  for (const key of ["body", "data", "response"]) {
    if (obj[key]) {
      const nested = extractErrorBody(obj[key]);
      if (nested) return nested;
    }
  }

  return undefined;
}

/** Type guard: is this value a Porulle API error (envelope or bare body)? */
export function isApiError(e: unknown): boolean {
  return extractErrorBody(e) !== undefined;
}

/**
 * Flatten an API error into field-level and form-level messages for binding
 * to a form. `fieldErrors` is keyed by the issue's dotted path; `formError`
 * is the top-level message.
 *
 * ```ts
 * const { data, error } = await client.POST("/api/things", { body });
 * if (error) {
 *   const { fieldErrors, formError } = mapApiErrorToFields(error);
 * }
 * ```
 */
export function mapApiErrorToFields(e: unknown): {
  fieldErrors: Record<string, string>;
  formError: string;
} {
  const body = extractErrorBody(e);
  const fieldErrors: Record<string, string> = {};
  for (const issue of body?.details?.issues ?? []) {
    if (issue.path && fieldErrors[issue.path] === undefined) {
      fieldErrors[issue.path] = issue.message;
    }
  }
  return { fieldErrors, formError: body?.message ?? "" };
}
