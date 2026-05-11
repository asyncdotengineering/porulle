import { describe, expect, it, afterEach } from "vitest";
import { createTestServer } from "../src/test-utils/rest-api-test-utils.js";

async function throwingStoreResolver(_request: Request): Promise<string | null> {
  throw new Error("storeResolver synthetic failure");
}

describe("storeResolver strict org resolution (anonymous requests)", () => {
  afterEach(() => {
    delete process.env.STRICT_ORG_RESOLUTION;
  });

  it("returns 503 ORG_RESOLUTION_FAILED when strictOrgResolution is true and storeResolver throws", async () => {
    const { server, cleanup } = await createTestServer({
      auth: {
        storeResolver: throwingStoreResolver,
        strictOrgResolution: true,
      },
    });
    try {
      const res = await server.fetch(
        new Request("http://localhost/api/health", { method: "GET" }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("ORG_RESOLUTION_FAILED");
      expect(JSON.stringify(body)).toContain("ORG_RESOLUTION_FAILED");
    } finally {
      await cleanup();
    }
  });

  it("returns 503 ORG_RESOLUTION_FAILED when STRICT_ORG_RESOLUTION=true and strictOrgResolution is unset", async () => {
    process.env.STRICT_ORG_RESOLUTION = "true";
    const { server, cleanup } = await createTestServer({
      auth: {
        storeResolver: throwingStoreResolver,
      },
    });
    try {
      const res = await server.fetch(
        new Request("http://localhost/api/health", { method: "GET" }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("ORG_RESOLUTION_FAILED");
    } finally {
      await cleanup();
    }
  });

  /**
   * Legacy path: resolver errors do not fail the request; anonymous traffic
   * proceeds with actor = null so public routes (e.g. health) still work.
   */
  it("legacy fallback: storeResolver throws, strict off, no env — request continues (public /api/health 200)", async () => {
    const { server, cleanup } = await createTestServer({
      auth: {
        storeResolver: throwingStoreResolver,
      },
    });
    try {
      const res = await server.fetch(
        new Request("http://localhost/api/health", { method: "GET" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    } finally {
      await cleanup();
    }
  });
});
