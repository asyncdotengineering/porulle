import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { DEFAULT_CUSTOMER_PERMISSIONS } from "../src/auth/middleware.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

const ORG_A = "org_d92e0661_a";
const ORG_B = "org_d92e0661_b";

const adminB: Actor = {
  type: "user",
  userId: "d92e0661-admin-b",
  email: "admin-b@d92e0661.test",
  name: "Admin B",
  vendorId: null,
  organizationId: ORG_B,
  role: "admin",
  permissions: ["catalog:create", "catalog:read", "catalog:update"],
};

const readerA: Actor = {
  type: "user",
  userId: "d92e0661-reader-a",
  email: "reader-a@d92e0661.test",
  name: "Reader A",
  vendorId: null,
  organizationId: ORG_A,
  role: "staff",
  permissions: ["catalog:read"],
};

const noCatalogRead: Actor = {
  ...adminB,
  userId: "d92e0661-no-read",
  email: "no-read@d92e0661.test",
  permissions: ["catalog:create", "catalog:update"],
};

const catalogWriterOnly: Actor = {
  ...adminB,
  userId: "d92e0661-writer-only",
  email: "writer-only@d92e0661.test",
  permissions: ["catalog:read", "catalog:update"],
};

const unpublishedReader: Actor = {
  ...adminB,
  userId: "d92e0661-unpublished-reader",
  email: "unpublished-reader@d92e0661.test",
  role: "catalog_reader",
  permissions: ["catalog:read", "catalog:read:unpublished"],
};

describe("d92e0661 — catalog read authorization", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    const testServer = await createTestServer();
    server = testServer.server;
    cleanup = testServer.cleanup;

    await testServer.kernel.services.organization.create({ id: ORG_A, name: "D92 Org A", slug: "d92-a" });
    await testServer.kernel.services.organization.create({ id: ORG_B, name: "D92 Org B", slug: "d92-b" });

    const response = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: "d92e0661-draft-product",
        status: "draft",
        isVisible: false,
        metadata: { secret: "unpublished" },
      },
      actor: adminB,
    });
    expect(response.status).toBe(201);
    entityId = (await parseJsonResponse<{ data: { id: string; status: string; isVisible: boolean } }>(response)).data.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("keeps catalog:read in the default customer permissions so storefronts still read", () => {
    // storeResolver gives an anonymous storefront visitor an actor carrying
    // these permissions. Guarding catalog reads with `catalog:read` is only
    // safe for public storefronts while this set grants it.
    expect(DEFAULT_CUSTOMER_PERMISSIONS).toContain("catalog:read");
  });

  it("returns 401 and no record to an unauthenticated entity-by-id request", async () => {
    const response = await server.fetch(
      new Request(`http://localhost/api/catalog/entities/${entityId}`),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("organizationId");
  });

  it.each([
    "/api/catalog/entities",
    "/api/catalog/categories",
    "/api/catalog/brands",
  ])("returns 401 for an unauthenticated GET %s", async (path) => {
    const response = await server.fetch(new Request(`http://localhost${path}`));
    expect(response.status).toBe(401);
  });

  it("does not return a draft entity to an authenticated actor lacking catalog:read", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}`,
      actor: noCatalogRead,
    });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("unpublished");
  });

  it("returns a draft entity to an actor with catalog:read:unpublished but not catalog:update", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}`,
      actor: unpublishedReader,
    });

    expect(response.status).toBe(200);
    const json = await parseJsonResponse<{ data: { status: string; isVisible: boolean } }>(response);
    expect(json.data.status).toBe("draft");
    expect(json.data.isVisible).toBe(false);
  });

  it("lists draft entities to an actor with catalog:read:unpublished", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/catalog/entities?status=draft",
      actor: unpublishedReader,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("d92e0661-draft-product");
  });

  it("does not let catalog:update imply unpublished catalog reads", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}`,
      actor: catalogWriterOnly,
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("unpublished");
  });

  it("does not return another organization's entity by id", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}`,
      actor: readerA,
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("unpublished");
  });

  it("returns the draft entity only to an authorized actor in its organization", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}`,
      actor: unpublishedReader,
    });

    expect(response.status).toBe(200);
    const json = await parseJsonResponse<{ data: { organizationId: string; status: string; isVisible: boolean } }>(response);
    expect(json.data.organizationId).toBe(ORG_B);
    expect(json.data.status).toBe("draft");
    expect(json.data.isVisible).toBe(false);
  });
});
