import { HTTPException } from "hono/http-exception";
import { toCommerceError } from "./errors.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../runtime/logger.js";

const statusByCode: Record<string, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  FORBIDDEN: 403,
  CSRF_ORIGIN_REJECTED: 403,
  CONFLICT: 409,
  INVALID_TRANSITION: 422,
  ORG_RESOLUTION_FAILED: 503,
};

export function mapErrorToStatus(error: unknown): ContentfulStatusCode {
  const normalized = toCommerceError(error);
  return statusByCode[normalized.code] ?? 500;
}

export interface ErrorMapping {
  body: { error: { code: string; message: string } };
  status: ContentfulStatusCode;
}

const httpStatusCodeMap: Record<number, string> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
};

function httpExceptionCode(status: number): string {
  return httpStatusCodeMap[status] ?? "REQUEST_REJECTED";
}

export function mapErrorToResponse(
  err: unknown,
  isProd: boolean,
  logger?: Logger,
): ErrorMapping {
  const message = err instanceof Error ? err.message : String(err);

  // ZodError from @hono/zod-openapi validation (bypasses defaultHook)
  if (
    (err as { constructor?: { name: string } }).constructor?.name === "ZodError" ||
    "issues" in (err as object)
  ) {
    if (isProd) {
      return {
        body: { error: { code: "VALIDATION_FAILED", message: "Invalid input." } },
        status: 422,
      };
    }
    const issues = (err as { issues?: Array<{ path: string[]; message: string }> }).issues ?? [];
    return {
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      },
      status: 422,
    };
  }

  // Hono HTTPException — CSRF, body-limit, rate-limit, route guards
  if (err instanceof HTTPException) {
    return {
      body: {
        error: {
          code: httpExceptionCode(err.status),
          message: isProd ? "Request rejected." : (err.message || "Request rejected."),
        },
      },
      status: err.status,
    };
  }

  // Malformed JSON body from c.req.json()
  if (err instanceof SyntaxError || /malformed json|unexpected token/i.test(message)) {
    return {
      body: { error: { code: "BAD_REQUEST", message: "Malformed JSON in request body." } },
      status: 400,
    };
  }

  // CommerceError subclasses → mapped status (403 / 404 / 409 / 422 / 503)
  if (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    const status = mapErrorToStatus(err);
    if (status !== 500) {
      const errorCode = (err as { code: string }).code;
      return {
        body: {
          error: {
            code: errorCode,
            message: isProd && status >= 500 ? "An error occurred." : err.message,
          },
        },
        status,
      };
    }
  }

  logger?.error({ err }, "unhandled request error");
  return {
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: isProd ? "An unexpected error occurred." : message,
      },
    },
    status: 500,
  };
}
