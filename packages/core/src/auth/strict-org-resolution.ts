import type { CommerceConfig } from "../config/types.js";

let _bootStrictOrgResolution = false;

export function setBootStrictOrgResolution(strict: boolean): void {
  _bootStrictOrgResolution = strict;
}

export function isStrictOrgResolution(config?: CommerceConfig | null): boolean {
  if (config?.auth?.strictOrgResolution === true) return true;
  if (process.env.STRICT_ORG_RESOLUTION === "true") return true;
  if ((config === undefined || config === null) && _bootStrictOrgResolution) return true;
  return false;
}
