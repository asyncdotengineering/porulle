import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestServer, makeRequest, parseJsonResponse } from "../src/test-utils/rest-api-test-utils.js";

const ORG_A = "org_4f9ee97f_a";
const ORG_B = "org_4f9ee97f_b";
const storefrontA: Actor = {
  type: "user",
  userId: "storefront-a-4f9ee97f",
  email: "storefront-a@4f9ee97f.test",
  name: "Storefront A",
  vendorId: null,
  organizationId: ORG_A,
  role: "customer",
  permissions: ["catalog:read"],
};

const readerA: Actor = {
  type: "user",
  userId: "reader-a-4f9ee97f",
  email: "reader-a@4f9ee97f.test",
  name: "Reader A",
  vendorId: null,
  organizationId: ORG_A,
  role: "staff",
  permissions: ["catalog:read"],
};

const adminB: Actor = {
  type: "user",
  userId: "admin-b-4f9ee97f",
  email: "admin-b@4f9ee97f.test",
  name: "Admin B",
  vendorId: null,
  organizationId: ORG_B,
  role: "admin",
  permissions: ["catalog:create", "catalog:read", "catalog:read:unpublished", "catalog:update"],
};

const adminA: Actor = {
  ...adminB,
  userId: "admin-a-4f9ee97f",
  email: "admin-a@4f9ee97f.test",
  organizationId: ORG_A,
  permissions: adminB.permissions,
};

const adminDefault: Actor = {
  ...adminA,
  userId: "admin-default-4f9ee97f",
  email: "admin-default@4f9ee97f.test",
  organizationId: "org_default",
};

describe("4f9ee97f catalog security hardening", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Awaited<ReturnType<typeof createTestServer>>["kernel"];
  let cleanup: () => Promise<void>;
  let entityId: string;
  let draftId: string;
  let hiddenId: string;
  let categoryIdInB: string;
  let brandIdInB: string;

  beforeAll(async () => {
    const testServer = await createTestServer({
      auth: {
        storeResolver: (request) => request.headers.get("x-store-id"),
      },
    });
    server = testServer.server;
    kernel = testServer.kernel;
    cleanup = testServer.cleanup;

    await testServer.kernel.services.organization.create({ id: ORG_A, name: "4f9 Org A", slug: "4f9-a" });
    await testServer.kernel.services.organization.create({ id: ORG_B, name: "4f9 Org B", slug: "4f9-b" });

    const category = await testServer.kernel.services.catalog.createCategory({ slug: "4f9-category-b" }, adminB);
    if (!category.ok) throw new Error(`category seed failed: ${JSON.stringify(category.error)}`);
    categoryIdInB = category.value.id;

    const brand = await testServer.kernel.services.catalog.createBrand(
      { slug: "4f9-brand-b", displayName: "4f9 Brand B" },
      adminB,
    );
    if (!brand.ok) throw new Error(`brand seed failed: ${JSON.stringify(brand.error)}`);

    const created = await testServer.kernel.services.catalog.create(
      {
        type: "product",
        slug: "4f9-attribute-victim",
        attributes: { locale: "en", title: "SECRET B TITLE", description: "SECRET B DESCRIPTION" },
      },
      adminB,
    );
    if (!created.ok) throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
    entityId = created.value.id;
    brandIdInB = brand.value.id;

    const defaultEntity = await testServer.kernel.services.catalog.create(
      {
        type: "product",
        slug: "4f9-default-tenant",
        status: "active",
        attributes: { locale: "en", title: "DEFAULT TENANT SECRET" },
      },
      adminDefault,
    );
    if (!defaultEntity.ok) throw new Error(`default tenant seed failed: ${JSON.stringify(defaultEntity.error)}`);

    const draft = await testServer.kernel.services.catalog.create(
      {
        type: "product",
        slug: "4f9-draft",
        status: "draft",
        attributes: { locale: "en", title: "DRAFT ATTRIBUTE SECRET" },
        metadata: { secret: "DRAFT SECRET" },
      },
      adminA,
    );
    if (!draft.ok) throw new Error(`draft seed failed: ${JSON.stringify(draft.error)}`);
    draftId = draft.value.id;

    const hidden = await testServer.kernel.services.catalog.create(
      {
        type: "product",
        slug: "4f9-hidden",
        status: "active",
        attributes: { locale: "en", title: "HIDDEN ATTRIBUTE SECRET" },
        metadata: { secret: "HIDDEN SECRET" },
      },
      adminA,
    );
    if (!hidden.ok) throw new Error(`hidden seed failed: ${JSON.stringify(hidden.error)}`);
    const hiddenUpdate = await testServer.kernel.services.catalog.update(
      hidden.value.id,
      { isVisible: false },
      adminA,
    );
    if (!hiddenUpdate.ok) throw new Error(`hidden update failed: ${JSON.stringify(hiddenUpdate.error)}`);
    hiddenId = hidden.value.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("does not return another organization's attributes to a catalog reader", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}/attributes/en`,
      actor: readerA,
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("SECRET B TITLE");
  });

  it("does not return attributes to an anonymous storefront visitor", async () => {
    const response = await server.fetch(
      new Request(`http://localhost/api/catalog/entities/${entityId}/attributes/en`, {
        headers: { "x-store-id": ORG_A },
      }),
    );

    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("SECRET B TITLE");
  });

  it("still returns an entity's attributes to a reader in its organization", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}/attributes/en`,
      actor: adminB,
    });

    expect(response.status).toBe(200);
    const body = await parseJsonResponse<{ data: { title: string } }>(response);
    expect(body.data.title).toBe("SECRET B TITLE");
  });

  it("hides draft and invisible entities from a storefront reader by id", async () => {
    for (const id of [draftId, hiddenId]) {
      const response = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/catalog/entities/${id}`,
        actor: storefrontA,
      });

      expect(response.status).toBe(404);
      expect(await response.text()).not.toMatch(/DRAFT SECRET|HIDDEN SECRET/);
    }
  });

  it("hides unpublished attributes from a storefront reader", async () => {
    for (const id of [draftId, hiddenId]) {
      const response = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/catalog/entities/${id}/attributes/en`,
        actor: storefrontA,
      });

      expect(response.status).toBe(404);
      expect(await response.text()).not.toMatch(/DRAFT ATTRIBUTE SECRET|HIDDEN ATTRIBUTE SECRET/);
    }
  });

  it("hides drafts from a storefront list even when status=draft is requested", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/catalog/entities?status=draft",
      actor: storefrontA,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("DRAFT SECRET");
  });

  it("allows an elevated catalog editor to read drafts", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${draftId}`,
      actor: adminA,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("DRAFT SECRET");
  });

  it("does not use a cross-organization category id as an existence oracle", async () => {
    const otherOrganization = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities?category=${categoryIdInB}`,
      actor: readerA,
    });
    const nonexistent = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/catalog/entities?category=00000000-0000-0000-0000-000000000000",
      actor: readerA,
    });

    expect(otherOrganization.status).toBe(nonexistent.status);
    const otherBody = (await otherOrganization.text()).replace(categoryIdInB, "<category-id>");
    const nonexistentBody = (await nonexistent.text()).replace(
      "00000000-0000-0000-0000-000000000000",
      "<category-id>",
    );
    expect(otherBody).toBe(nonexistentBody);
  });

  it("does not use a cross-organization brand id as an existence oracle", async () => {
    const otherOrganization = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities?brand=${brandIdInB}`,
      actor: readerA,
    });
    const nonexistent = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/catalog/entities?brand=00000000-0000-0000-0000-000000000000",
      actor: readerA,
    });

    expect(otherOrganization.status).toBe(nonexistent.status);
    expect(await otherOrganization.text()).toBe(await nonexistent.text());
  });

  it("does not turn a malformed brand filter into a server error", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/catalog/entities?brand=not-a-uuid",
      actor: readerA,
    });

    expect(response.status).not.toBe(500);
  });

  it("requires an actor for both search endpoints", async () => {
    const search = await server.fetch(new Request("http://localhost/api/search?q=4f9-default-tenant"));
    const suggest = await server.fetch(new Request("http://localhost/api/search/suggest?prefix=DEFAULT"));

    expect(search.status).toBe(401);
    expect(suggest.status).toBe(401);
  });

  it("does not expose unpublished entities through storefront search", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/search?q=4f9-draft",
      actor: storefrontA,
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("4f9-draft");
    expect(body).not.toContain("DRAFT SECRET");
  });

  it("does not use the boot default organization for an actorless search service read", async () => {
    const result = await kernel.services.search.query({ query: "4f9-default-tenant" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hits).toHaveLength(0);
  });
});
