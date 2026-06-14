/**
 * PATCH /api/customers/:id metadata merge (#8)
 *
 * A single-key metadata edit must not clobber the rest of the blob. The PATCH
 * now shallow-merges top-level metadata keys by default; ?metadataReplace=true
 * restores the old replace behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import type { Actor } from "../src/auth/types.js";

const admin: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-0000000000ad",
  email: null,
  name: "Admin",
  vendorId: null,
  organizationId: "org_default",
  role: "owner",
  permissions: ["*:*"],
};

describe("PATCH /api/customers/:id metadata merge (#8)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const r = await createTestServer();
    server = r.server;
    kernel = r.kernel;
    cleanup = r.cleanup;
  });
  afterEach(async () => { await cleanup(); });

  async function seedCustomer(metadata: Record<string, unknown>): Promise<string> {
    const r = await kernel.services.customers.updateByUserId("u-merge", { metadata }, admin);
    return r.value.id as string;
  }

  it("merges top-level metadata keys by default", async () => {
    const id = await seedCustomer({ a: 1, b: 2 });
    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/customers/${id}`,
      body: { metadata: { b: 3, c: 4 } },
      actor: admin,
    });
    expect(res.status).toBe(200);
    const json = await parseJsonResponse<{ data: { metadata: Record<string, unknown> } }>(res);
    expect(json.data.metadata).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("replaces metadata when ?metadataReplace=true", async () => {
    const id = await seedCustomer({ a: 1, b: 2 });
    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/customers/${id}?metadataReplace=true`,
      body: { metadata: { x: 9 } },
      actor: admin,
    });
    expect(res.status).toBe(200);
    const json = await parseJsonResponse<{ data: { metadata: Record<string, unknown> } }>(res);
    expect(json.data.metadata).toEqual({ x: 9 });
  });
});
