import { describe, expect, it, afterEach, vi } from "vitest";
import type { CommerceConfig } from "../src/config/types.js";
import {
  resolveOrgId,
  DEFAULT_ORG_ID,
  setBootDefaultOrgId,
} from "../src/auth/org.js";
import { OrgResolutionError } from "../src/kernel/errors.js";
import { setBootStrictOrgResolution } from "../src/auth/strict-org-resolution.js";

describe("resolveOrgId strict org resolution (MT-2)", () => {
  afterEach(() => {
    delete process.env.STRICT_ORG_RESOLUTION;
    setBootDefaultOrgId("");
    setBootStrictOrgResolution(false);
    vi.restoreAllMocks();
  });

  const actorWithOrg = { organizationId: "org_from_actor" };

  it("returns organizationId from actor in strict mode", () => {
    process.env.STRICT_ORG_RESOLUTION = "true";
    expect(resolveOrgId(actorWithOrg)).toBe("org_from_actor");
  });

  it("returns organizationId from actor in legacy mode", () => {
    expect(resolveOrgId(actorWithOrg)).toBe("org_from_actor");
  });

  it("returns explicit defaultOrgId in strict mode", () => {
    process.env.STRICT_ORG_RESOLUTION = "true";
    expect(resolveOrgId(null, "param-org")).toBe("param-org");
  });

  it("returns explicit defaultOrgId in legacy mode", () => {
    expect(resolveOrgId(null, "param-org")).toBe("param-org");
  });

  it("returns boot default in strict mode", () => {
    setBootDefaultOrgId("boot-org");
    process.env.STRICT_ORG_RESOLUTION = "true";
    expect(resolveOrgId(null)).toBe("boot-org");
  });

  it("returns boot default in legacy mode", () => {
    setBootDefaultOrgId("boot-org");
    expect(resolveOrgId(null)).toBe("boot-org");
  });

  it("throws OrgResolutionError in strict mode when chain exhausts", () => {
    process.env.STRICT_ORG_RESOLUTION = "true";
    expect(() => resolveOrgId(null)).toThrow(OrgResolutionError);
    expect(() => resolveOrgId(null)).toThrow(
      expect.objectContaining({ code: "ORG_RESOLUTION_FAILED" }),
    );
  });

  it("applies boot strict flag when commerceConfig is omitted (matches createCommerce)", () => {
    setBootStrictOrgResolution(true);
    expect(() => resolveOrgId(null)).toThrow(OrgResolutionError);
  });

  it("throws when strictOrgResolution is set only on optional commerceConfig", () => {
    const cfg = { auth: { strictOrgResolution: true } } as CommerceConfig;
    expect(() => resolveOrgId(null, undefined, cfg)).toThrow(OrgResolutionError);
  });

  it('returns deprecated DEFAULT_ORG_ID in legacy mode with rate-limited warn', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveOrgId(null)).toBe(DEFAULT_ORG_ID);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain("org_default");
  });
});
