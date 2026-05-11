/**
 * Converts a PluginResultErr into a structured HTTP error response.
 *
 * Replaces the `throw new Error(result.error)` pattern in plugin routes
 * which always produces HTTP 500 with no structured error code.
 *
 * Usage in routes:
 *   const result = await service.doSomething(orgId, input);
 *   if (!result.ok) return toHttpError(result);
 *   return result.value;
 *
 * The function infers HTTP status from the error code or message content:
 *   - "NOT_FOUND" or "not found"        --> 404
 *   - "FORBIDDEN" or "permission"        --> 403
 *   - "CONFLICT" or "already exists"     --> 409
 *   - "VALIDATION" or "cannot/must"      --> 422
 *   - Everything else                    --> 400
 */

import type { PluginResultErr } from "./result.js";

export interface HttpErrorResponse {
  status: 400 | 403 | 404 | 409 | 422;
  body: { error: { code: string; message: string } };
}

export function toHttpError(result: PluginResultErr): HttpErrorResponse {
  const message = result.error;
  const code = result.code;

  if (code === "NOT_FOUND" || /not found/i.test(message)) {
    return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
  }
  if (code === "FORBIDDEN" || /permission|forbidden|unauthorized/i.test(message)) {
    return { status: 403, body: { error: { code: "FORBIDDEN", message } } };
  }
  if (code === "CONFLICT" || /already|duplicate|exists|unique/i.test(message)) {
    return { status: 409, body: { error: { code: "CONFLICT", message } } };
  }
  if (code === "VALIDATION" || /invalid|cannot|must|required|exceeded|negative/i.test(message)) {
    return { status: 422, body: { error: { code: "VALIDATION_FAILED", message } } };
  }
  return { status: 400, body: { error: { code: code ?? "BAD_REQUEST", message } } };
}
