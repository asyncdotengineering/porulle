/**
 * Categories: status + archive/restore + DELETE (#22)
 *
 * Categories gain an active|archived status. Archive/restore endpoints
 * soft-delete without cascading entity_categories; the list defaults to
 * active and ?includeArchived=true returns all. DELETE works for
 * catalog:update actors.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import type { Actor } from "../src/auth/types.js";

type Cat = { id: string; slug: string; status: string };

describe("REST API: categories archive/restore + DELETE (#22)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const r = await createTestServer();
    server = r.server;
    cleanup = r.cleanup;
  });
  afterAll(async () => { await cleanup(); });
  beforeEach(async () => { await cleanup(); });

  async function createCategory(slug: string): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/categories",
      body: { slug },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: Cat }>(res)).data.id;
  }

  async function listCategories(includeArchived = false): Promise<Cat[]> {
    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/categories${includeArchived ? "?includeArchived=true" : ""}`,
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: Cat[] }>(res)).data;
  }

  it("new categories are active and listed by default", async () => {
    const id = await createCategory("shoes");
    const list = await listCategories();
    const found = list.find((c) => c.id === id);
    expect(found?.status).toBe("active");
  });

  it("archive hides from the default list; includeArchived shows it; restore brings it back", async () => {
    const id = await createCategory("seasonal");

    const archived = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/categories/${id}/archive`,
      actor: testActor,
    });
    expect(archived.status).toBe(200);
    expect((await parseJsonResponse<{ data: Cat }>(archived)).data.status).toBe("archived");

    expect((await listCategories()).find((c) => c.id === id)).toBeUndefined();
    expect((await listCategories(true)).find((c) => c.id === id)?.status).toBe("archived");

    const restored = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/categories/${id}/restore`,
      actor: testActor,
    });
    expect((await parseJsonResponse<{ data: Cat }>(restored)).data.status).toBe("active");
    expect((await listCategories()).find((c) => c.id === id)?.status).toBe("active");
  });

  it("DELETE works for a catalog:update actor", async () => {
    const id = await createCategory("temp");
    const res = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/catalog/categories/${id}`,
      actor: testActor,
    });
    expect(res.status).toBe(200);
    expect((await listCategories(true)).find((c) => c.id === id)).toBeUndefined();
  });

  it("archive requires catalog:update (403 without it)", async () => {
    const id = await createCategory("guarded");
    const noPerm: Actor = { ...testActor, permissions: ["catalog:read"] };
    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/categories/${id}/archive`,
      actor: noPerm,
    });
    expect(res.status).toBe(403);
  });
});
