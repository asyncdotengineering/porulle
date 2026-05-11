export interface CommerceError {
  code: string;
  message: string;
  details?: unknown;
}

export interface FieldError {
  field: string;
  message: string;
}

export class CommerceNotFoundError extends Error implements CommerceError {
  code = "NOT_FOUND" as const;
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CommerceNotFoundError";
  }
}

export class CommerceValidationError extends Error implements CommerceError {
  code = "VALIDATION_FAILED" as const;
  constructor(
    message: string,
    public fieldErrors?: FieldError[],
    public details?: unknown,
  ) {
    super(message);
    this.name = "CommerceValidationError";
  }
}

export class CommerceForbiddenError extends Error implements CommerceError {
  code = "FORBIDDEN" as const;
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CommerceForbiddenError";
  }
}

export class CommerceConflictError extends Error implements CommerceError {
  code = "CONFLICT" as const;
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CommerceConflictError";
  }
}

export class CommerceInvalidTransitionError extends Error implements CommerceError {
  code = "INVALID_TRANSITION" as const;
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CommerceInvalidTransitionError";
  }
}

export class OrgResolutionError extends Error implements CommerceError {
  code = "ORG_RESOLUTION_FAILED" as const;
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "OrgResolutionError";
  }
}

export function isCommerceError(value: unknown): value is CommerceError {
  if (!value || typeof value !== "object") return false;
  return "code" in value && "message" in value;
}

export function toCommerceError(error: unknown): CommerceError {
  if (isCommerceError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
      details: { name: error.name },
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Unexpected server error",
    details: error,
  };
}
