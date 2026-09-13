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
        new Request("http://localhost/api/catalog/entities?limit=1", { method: "GET" }),
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
        new Request("http://localhost/api/catalog/entities?limit=1", { method: "GET" }),
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
   * Legacy opt-out path: with strictOrgResolution explicitly false, a resolver
   * error does not fail the request — it continues with actor = null and is
   * judged by the ordinary authorization layer.
   *
   * It asserted `/api/health` 200 until 2026-09-13. That route now resolves no
   * actor at all, so it answers 200 whatever this flag says and the assertion
   * had stopped being able to fail — a gate that cannot go red is not a gate.
   * Moved onto the same organization-dependent route as the two rows above, so
   * the pair discriminates: strict ON short-circuits at 503 before any handler;
   * strict OFF reaches the permission layer, which refuses an actor-less caller
   * 401. The subject is which of those two happens, and it is now visible.
   */
  it("legacy fallback: storeResolver throws, strict explicitly off — the request continues to the authorization layer", async () => {
    // Strict org resolution now defaults ON, so the legacy fallback is opt-in.
    // This test exercises that opt-out path deliberately.
    const { server, cleanup } = await createTestServer({
      auth: {
        storeResolver: throwingStoreResolver,
        strictOrgResolution: false,
      },
    });
    try {
      const res = await server.fetch(
        new Request("http://localhost/api/catalog/entities?limit=1", { method: "GET" }),
      );
      // NOT 503: the point is that strict did not short-circuit it. 401 is the
      // authorization layer answering a caller the resolver could not identify,
      // which means the request was allowed to get that far.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await cleanup();
    }
  });
});
