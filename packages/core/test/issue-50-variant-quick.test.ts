import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  noPermActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #50 — creating a sellable variant took three API calls (option type →
// option value → variant) and still left no inventory_levels row. The quick
// and bulk endpoints upsert option axes inline, create the variant(s), and
// seed a zero-stock inventory level so the variant is sellable immediately.
describe("Issue #50 — one-call quick/bulk variant creation", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `e50-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "Saree" } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function levelsFor(entityId: string): Promise<any[]> {
    const result = await kernel.services.inventory.getLevelsByEntityId(entityId, testActor);
    expect(result.ok).toBe(true);
    return result.value;
  }

  it("quick: one call upserts axes, creates the variant, and seeds inventory", async () => {
    const entityId = await createEntity();

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/quick`,
      body: { options: { color: "Red", size: "M" }, sku: `SAREE-R-M-${Date.now()}` },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const created = (await parseJsonResponse<{ data: any }>(res)).data;
    expect(created.created).toBe(true);
    expect(created.variant.entityId).toBe(entityId);

    // Zero-stock inventory row exists → variant is sellable
    const levels = await levelsFor(entityId);
    const level = levels.find((l: any) => l.variantId === created.variant.id);
    expect(level).toBeDefined();
    expect(level.quantityOnHand).toBe(0);

    // Same combination again → idempotent, returns the existing variant
    const again = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/quick`,
      body: { options: { color: "Red", size: "M" } },
      actor: testActor,
    });
    expect(again.status).toBe(200);
    const existing = (await parseJsonResponse<{ data: any }>(again)).data;
    expect(existing.created).toBe(false);
    expect(existing.variant.id).toBe(created.variant.id);
  });

  it("bulk: a matrix call creates all combinations, skipping existing ones", async () => {
    const entityId = await createEntity();

    // Pre-create one combination via quick
    await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/quick`,
      body: { options: { color: "Red", size: "S" } },
      actor: testActor,
    });

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/bulk`,
      body: { axes: [
        { name: "color", values: ["Red", "Blue"] },
        { name: "size", values: ["S", "M"] },
      ] },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const result = (await parseJsonResponse<{ data: any }>(res)).data;
    expect(result.created.length).toBe(3); // Red/M, Blue/S, Blue/M — Red/S existed
    expect(result.skipped).toBe(1);

    // Every created variant has a seeded inventory row
    const levels = await levelsFor(entityId);
    for (const variant of result.created) {
      expect(levels.some((l: any) => l.variantId === variant.id)).toBe(true);
    }
  });

  it("bulk with no axes creates a single option-less variant", async () => {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/bulk`,
      body: { axes: [] },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const result = (await parseJsonResponse<{ data: any }>(res)).data;
    expect(result.created.length).toBe(1);
    const levels = await levelsFor(entityId);
    expect(levels.some((l: any) => l.variantId === result.created[0].id)).toBe(true);
  });

  it("requires catalog:update + inventory:adjust", async () => {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/quick`,
      body: { options: { color: "Red" } },
      actor: noPermActor,
    });
    expect(res.status).toBe(403);
  });
});
