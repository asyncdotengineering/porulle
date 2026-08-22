import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommerceConfig } from "../src/config/types.js";
import { createServer } from "../src/runtime/server.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

describe("organization resolution startup guard", () => {
  let baseConfig: CommerceConfig;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testConfig = await createPGliteTestConfig({
      exposeOpenApiSpec: false,
      auth: { strictOrgResolution: true },
    });
    baseConfig = testConfig.config;
    cleanup = testConfig.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  function configWithAuth(auth: CommerceConfig["auth"]): CommerceConfig {
    return { ...baseConfig, auth: { ...baseConfig.auth, ...auth } };
  }

  async function expectStartupFailure(config: CommerceConfig, message: string): Promise<void> {
    let error: unknown;
    try {
      await createServer(config);
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining(message) }));
  }

  it("refuses strict construction without either organization remedy", async () => {
    await expectStartupFailure(
      configWithAuth({ strictOrgResolution: true }),
      "Cannot resolve an organization for a request with no actor. Set auth.defaultOrganizationId for a single-tenant deployment, or auth.storeResolver for a multi-tenant one. To keep the previous permissive behaviour during a migration, set auth.strictOrgResolution: false (or STRICT_ORG_RESOLUTION=false).",
    );
  });

  it.each(["", "   "])(
    "treats a blank defaultOrganizationId (%j) as absent",
    async (defaultOrganizationId) => {
      await expectStartupFailure(
        configWithAuth({ defaultOrganizationId, strictOrgResolution: true }),
        "Cannot resolve an organization for a request with no actor.",
      );
    },
  );

  it("boots with only a non-empty defaultOrganizationId", async () => {
    await expect(
      createServer(configWithAuth({
        defaultOrganizationId: "org_single",
        strictOrgResolution: true,
      })),
    ).resolves.toBeDefined();
  });

  it("boots with only a storeResolver", async () => {
    await expect(
      createServer(configWithAuth({
        storeResolver: () => "org_from_store",
        strictOrgResolution: true,
      })),
    ).resolves.toBeDefined();
  });

  it("boots without either remedy when strict resolution is explicitly disabled", async () => {
    await expect(
      createServer(configWithAuth({ strictOrgResolution: false })),
    ).resolves.toBeDefined();
  });
});
