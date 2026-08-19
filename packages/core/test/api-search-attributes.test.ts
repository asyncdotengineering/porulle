import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

describe("REST API: Search attribute filters", () => {
  let server: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer({
      entities: {
        product: {
          fields: [
            { name: "material", type: "select", options: ["linen", "cotton"], filterable: true },
            { name: "occasion", type: "text", filterable: true },
            { name: "internal_note", type: "text" },
          ],
          variants: { enabled: false },
          fulfillment: "physical",
        },
      },
    });
    server = result.server;
    cleanup = result.cleanup;

    const products: Array<Record<string, unknown>> = [
      { slug: "linen-resort", customFields: { material: "linen", occasion: "resort" } },
      { slug: "linen-office", customFields: { material: "linen", occasion: "office" } },
      { slug: "cotton-resort", customFields: { material: "cotton", occasion: "resort" } },
    ];
    for (const product of products) {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: { type: "product", ...product },
        actor: testActor,
      });
      expect(response.status).toBe(201);
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it("filters by a single attribute", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/search?attr.material=linen",
    });
    expect(response.status).toBe(200);
    const json = await parseJsonResponse<{ data: Array<{ document: { slug: string } }> }>(response);
    expect(json.data.map((hit) => hit.document.slug).sort()).toEqual(["linen-office", "linen-resort"]);
  });

  it("applies AND across keys and OR within a key", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/search?attr.material=linen&attr.occasion=resort&attr.occasion=wedding",
    });
    expect(response.status).toBe(200);
    const json = await parseJsonResponse<{ data: Array<{ document: { slug: string } }> }>(response);
    expect(json.data.map((hit) => hit.document.slug)).toEqual(["linen-resort"]);
  });

  it("returns nothing for a non-filterable field", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/search?attr.internal_note=anything",
    });
    expect(response.status).toBe(200);
    const json = await parseJsonResponse<{ data: unknown[] }>(response);
    expect(json.data).toHaveLength(0);
  });

  it("rejects attribute names outside the safe pattern", async () => {
    const malicious = encodeURIComponent('x = "a" OR type');
    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/search?attr.${malicious}=v`,
    });
    expect(response.status).toBe(422);
  });

  it("returns facet counts for a requested attribute over the filtered set", async () => {
    const response = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/search?attr.occasion=resort&facets=material",
    });
    expect(response.status).toBe(200);
    const json = await parseJsonResponse<{ meta: { facets: Record<string, Record<string, number>> } }>(response);
    expect(json.meta.facets.material).toEqual({ linen: 1, cotton: 1 });
  });
});
