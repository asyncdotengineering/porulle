/**
 * PATCH /api/promotions/:id (#6)
 *
 * Edit a promotion's fields post-creation, validated the same way create is.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import type { Actor } from "../src/auth/types.js";

describe("REST API: PATCH /api/promotions/:id (#6)", () => {
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

  async function createPromo(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/promotions",
      body: { code: "EDIT10", name: "Original", type: "percentage_off_order", value: 10 },
      actor: testActor,
    });
    const json = await parseJsonResponse<{ data: { id: string } }>(res);
    return json.data.id;
  }

  it("edits name and value", async () => {
    const id = await createPromo();
    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/promotions/${id}`,
      body: { name: "Updated Name", value: 25 },
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const json = await parseJsonResponse<{ data: { name: string; value: number } }>(res);
    expect(json.data.name).toBe("Updated Name");
    expect(Number(json.data.value)).toBe(25);
  });

  it("rejects a negative value with 422", async () => {
    const id = await createPromo();
    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/promotions/${id}`,
      body: { value: -5 },
      actor: testActor,
    });
    expect(res.status).toBe(422);
    const json = await parseJsonResponse<{ error: { code: string } }>(res);
    expect(json.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/promotions/550e8400-e29b-41d4-a716-446655440000",
      body: { name: "x" },
      actor: testActor,
    });
    expect(res.status).toBe(404);
  });

  it("requires promotions:manage (403 without it)", async () => {
    const id = await createPromo();
    const noPerm: Actor = { ...testActor, permissions: ["catalog:read"] };
    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/promotions/${id}`,
      body: { name: "x" },
      actor: noPerm,
    });
    expect(res.status).toBe(403);
  });
});
