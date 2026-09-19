import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";
import {
  CatalogEntityListResponse,
  OrderListResponse,
} from "../src/interfaces/rest/schemas/responses.js";

/**
 * `paginatedResponse` declares `meta: { page, limit, total? }` and the two routes built on it
 * serve `meta: { pagination: { page, limit, total, totalPages } }`. Nothing in the package can
 * see the difference: every list handler is written under `// @ts-expect-error -- openapi handler
 * union return type`, so the compiler never compares the returned body to the declared response,
 * and `router.openapi` does not validate responses at runtime.
 *
 * The consequence is not cosmetic. The OpenAPI document — and therefore every generated SDK type —
 * describes a `meta.total` the server never sends, so a consumer reading it gets `undefined` with
 * no type error and no test failure.
 *
 * These rows close that gap the only way it can be closed from inside the suite: parse the body the
 * server actually returns against the schema the route actually declares. The customer routes
 * already declare `meta.pagination` (`schemas/customers.ts:50,146`), so the house shape is settled
 * from inside the package and the schema is what moves, not the wire.
 */
type TestServer = Awaited<ReturnType<typeof createTestServer>>;

describe("a list route's served body parses against its own declared response schema", () => {
  let server: TestServer["server"];
  let cleanup: TestServer["cleanup"];

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    cleanup = result.cleanup;

    // Two entities, so `total` is a number a reader could actually be misled by rather than 0.
    for (const title of ["Sari", "Kurta"]) {
      const created = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `list-shape-${title.toLowerCase()}-${Date.now()}-${Math.round(performance.now() * 1000)}`,
          status: "active",
          metadata: { title, basePrice: 4000 },
        },
        actor: testActor,
      });
      expect(created.status).toBe(201);
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it("GET /api/catalog/entities", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/catalog/entities?page=1&limit=1",
      actor: testActor,
    });
    expect(response.status).toBe(200);

    const body = await parseJsonResponse<unknown>(response);
    const parsed = CatalogEntityListResponse.parse(body);

    // Not merely "it parsed". A schema widened to `meta: z.any()` would parse anything, so the
    // count the caller came for has to survive the round trip as a number.
    expect(typeof parsed.meta?.pagination?.total).toBe("number");
    expect(parsed.meta?.pagination?.total).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/orders", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/orders?page=1&limit=1",
      actor: testActor,
    });
    expect(response.status).toBe(200);

    const body = await parseJsonResponse<unknown>(response);
    const parsed = OrderListResponse.parse(body);

    expect(typeof parsed.meta?.pagination?.total).toBe("number");
  });
});
