import { CommerceValidationError } from "../../kernel/errors.js";

export type FieldPath = string;
export type FieldOwner = "platform" | "store" | "shared";

const fieldPathPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function isValidFieldPath(value: string): value is FieldPath {
  return fieldPathPattern.test(value);
}

export function validateFieldPath(value: string): FieldPath {
  if (!isValidFieldPath(value)) {
    throw new CommerceValidationError("Field path must contain dot-separated alphanumeric, underscore, or hyphen segments.");
  }
  return value;
}
