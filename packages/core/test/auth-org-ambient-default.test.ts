import { describe, expect, it, afterEach } from "vitest";
import type { CommerceConfig } from "../src/config/types.js";
import { resolveOrgId, setBootDefaultOrgId } from "../src/auth/org.js";
import { OrgResolutionError } from "../src/kernel/errors.js";
import { setBootStrictOrgResolution } from "../src/auth/strict-org-resolution.js";

describe("resolveOrgId ambient boot default vs strict resolution", () => {
  afterEach(() => {
    delete process.env.STRICT_ORG_RESOLUTION;
    setBootDefaultOrgId("");
    setBootStrictOrgResolution(false);
  });

  it("throws OrgResolutionError for null actor with boot default under strict resolution", () => {
    setBootDefaultOrgId("org_boot");
    process.env.STRICT_ORG_RESOLUTION = "true";
    expect(() => resolveOrgId(null)).toThrow(OrgResolutionError);
  });

  it("returns explicit defaultOrgId under strict resolution", () => {
    // Cases 2 and 3 pass under both orderings; they guard the explicit-argument path and the escape hatch.
    process.env.STRICT_ORG_RESOLUTION = "true";
    expect(resolveOrgId(null, "org_explicit")).toBe("org_explicit");
  });

  it("returns boot default when strict resolution is disabled", () => {
    setBootDefaultOrgId("org_boot");
    const legacy = { auth: { strictOrgResolution: false } } as CommerceConfig;
    expect(resolveOrgId(null, undefined, legacy)).toBe("org_boot");
  });
});
