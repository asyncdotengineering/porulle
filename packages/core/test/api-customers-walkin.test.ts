/**
 * POST /api/customers walk-in / userId-less creation (#5)
 *
 * A walk-in customer has no Better Auth user. Omitting userId generates a
 * synthetic anonymous_<uuid> id and flags metadata.walkIn = true; providing
 * userId binds to the given account.
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

type Customer = { id: string; userId: string; firstName: string | null; metadata: Record<string, unknown> };

describe("POST /api/customers walk-in creation (#5)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const r = await createTestServer();
    server = r.server;
    cleanup = r.cleanup;
  });
  afterEach(async () => { await cleanup(); });

  it("creates a walk-in customer without userId (anonymous id + walkIn flag)", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/customers",
      body: { firstName: "Nimali", lastName: "Perera", phone: "+94 77 412 6601" },
      actor: admin,
    });
    expect(res.status).toBe(201);
    const { data } = await parseJsonResponse<{ data: Customer }>(res);
    expect(data.userId).toMatch(/^anonymous_/);
    expect(data.metadata.walkIn).toBe(true);
    expect(data.firstName).toBe("Nimali");
  });

  it("binds to a provided userId (no walkIn flag)", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/customers",
      body: { userId: "user_explicit_1", firstName: "Account" },
      actor: admin,
    });
    expect(res.status).toBe(201);
    const { data } = await parseJsonResponse<{ data: Customer }>(res);
    expect(data.userId).toBe("user_explicit_1");
    expect(data.metadata.walkIn).toBeUndefined();
  });
});
