import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #41 — pricing modifiers were create-only: an operator could schedule
// a store-wide sale but then couldn't see, edit, or end it. GET (list),
// PATCH, and DELETE now exist under /api/pricing/modifiers.
describe("Issue #41 — pricing modifiers list / update / delete", () => {
  let server: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createModifier(body: Record<string, unknown>): Promise<any> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/pricing/modifiers",
      body: { type: "percentage_discount", value: 10, ...body },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    return (await parseJsonResponse<{ data: any }>(res)).data;
  }

  it("lists modifiers, including scheduled ones, and filters expired with active=true", async () => {
    const live = await createModifier({ name: "Live Sale" });
    const expired = await createModifier({
      name: "Expired Sale",
      validUntil: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    });

    const all = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/pricing/modifiers", actor: testActor }),
    );
    const allIds = all.data.map((m) => m.id);
    expect(allIds).toContain(live.id);
    expect(allIds).toContain(expired.id);

    const active = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/pricing/modifiers?active=true", actor: testActor }),
    );
    const activeIds = active.data.map((m) => m.id);
    expect(activeIds).toContain(live.id);
    expect(activeIds).not.toContain(expired.id);
  });

  it("filters modifiers by entityId", async () => {
    const entityRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `mod-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "M" } },
      actor: testActor,
    });
    const entityId = (await parseJsonResponse<{ data: { id: string } }>(entityRes)).data.id;

    const scoped = await createModifier({ name: "Entity Sale", entityId });
    await createModifier({ name: "Global Sale" });

    const filtered = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: `http://localhost/api/pricing/modifiers?entityId=${entityId}`, actor: testActor }),
    );
    expect(filtered.data.map((m: any) => m.id)).toEqual([scoped.id]);
  });

  it("updates a modifier's value and validity via PATCH", async () => {
    const mod = await createModifier({ name: "Adjustable Sale", value: 10 });

    const until = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/pricing/modifiers/${mod.id}`,
      body: { value: 25, validUntil: until },
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const updated = await parseJsonResponse<{ data: any }>(res);
    expect(updated.data.value).toBe(25);
    expect(new Date(updated.data.validUntil).toISOString()).toBe(until);
  });

  it("ends a sale early via DELETE and 404s for a missing modifier", async () => {
    const mod = await createModifier({ name: "Doomed Sale" });

    const del = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/pricing/modifiers/${mod.id}`,
      actor: testActor,
    });
    expect(del.status).toBe(200);

    const list = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/pricing/modifiers", actor: testActor }),
    );
    expect(list.data.map((m: any) => m.id)).not.toContain(mod.id);

    const again = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/pricing/modifiers/${mod.id}`,
      actor: testActor,
    });
    expect(again.status).toBe(404);
  });
});
