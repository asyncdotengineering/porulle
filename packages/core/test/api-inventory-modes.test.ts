/**
 * Inventory adjust modes + before/after/delta (#7)
 *
 * POST /api/inventory/adjust gains optional mode=add|remove|set on an unsigned
 * amount, and always returns { before, after, delta, movementId } alongside the
 * level. mode omitted ⇒ legacy signed-adjustment behavior. remove clamps at 0;
 * set writes an absolute quantity. All under a row lock.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

describe("REST API: inventory adjust modes (#7)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    const r = await createTestServer();
    server = r.server;
    cleanup = r.cleanup;
  });
  afterAll(async () => { await cleanup(); });

  beforeEach(async () => {
    await cleanup();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `inv-modes-${Date.now()}`, metadata: { title: "Inv Modes" } },
      actor: testActor,
    });
    entityId = (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  });

  async function adjust(body: Record<string, unknown>) {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/inventory/adjust",
      body: { entityId, reason: "test", ...body },
      actor: testActor,
    });
    return {
      status: res.status,
      json: await parseJsonResponse<{
        data: { before: number; after: number; delta: number; movementId: string; entityId: string };
      }>(res),
    };
  }

  it("mode=add increases stock and reports before/after/delta", async () => {
    const first = await adjust({ mode: "add", amount: 10 });
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ before: 0, after: 10, delta: 10, entityId });
    expect(first.json.data.movementId).toBeTruthy();

    const second = await adjust({ mode: "add", amount: 5 });
    expect(second.json.data).toMatchObject({ before: 10, after: 15, delta: 5 });
  });

  it("mode=remove clamps at 0", async () => {
    await adjust({ mode: "add", amount: 8 });
    const removed = await adjust({ mode: "remove", amount: 100 });
    expect(removed.json.data).toMatchObject({ before: 8, after: 0, delta: -8 });
  });

  it("mode=set writes an absolute quantity", async () => {
    await adjust({ mode: "add", amount: 3 });
    const set = await adjust({ mode: "set", amount: 12 });
    expect(set.json.data).toMatchObject({ before: 3, after: 12, delta: 9 });
  });

  it("legacy signed adjustment still works and reports before/after/delta", async () => {
    await adjust({ mode: "add", amount: 10 });
    const legacy = await adjust({ adjustment: 3 });
    expect(legacy.json.data).toMatchObject({ before: 10, after: 13, delta: 3, entityId });
  });
});
