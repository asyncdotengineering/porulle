/**
 * Customer interaction log (#3)
 *
 * CRUD for non-transactional clienteling interactions under
 * /api/customers/:id/interactions[/:iid].
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

type Interaction = { id: string; kind: string; notes: string; customerId: string };

describe("Customer interactions (#3)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let cleanup: () => Promise<void>;
  let customerId: string;

  beforeEach(async () => {
    const r = await createTestServer();
    server = r.server;
    cleanup = r.cleanup;
    const created = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/customers",
      body: { firstName: "Nimali", lastName: "Perera" },
      actor: admin,
    });
    customerId = (await parseJsonResponse<{ data: { id: string } }>(created)).data.id;
  });
  afterEach(async () => { await cleanup(); });

  function url(suffix = ""): string {
    return `http://localhost/api/customers/${customerId}/interactions${suffix}`;
  }

  it("creates, lists, edits, and deletes an interaction", async () => {
    // create
    const created = await makeRequest(server, {
      method: "POST",
      url: url(),
      body: { kind: "visit", notes: "Asked about the navy blazer in M." },
      actor: admin,
    });
    expect(created.status).toBe(201);
    const interaction = (await parseJsonResponse<{ data: Interaction }>(created)).data;
    expect(interaction.kind).toBe("visit");
    expect(interaction.customerId).toBe(customerId);

    // list
    const listed = await makeRequest(server, { method: "GET", url: url(), actor: admin });
    expect((await parseJsonResponse<{ data: Interaction[] }>(listed)).data).toHaveLength(1);

    // edit
    const edited = await makeRequest(server, {
      method: "PATCH",
      url: url(`/${interaction.id}`),
      body: { notes: "Followed up — will hold the blazer." },
      actor: admin,
    });
    expect(edited.status).toBe(200);
    expect((await parseJsonResponse<{ data: Interaction }>(edited)).data.notes).toBe(
      "Followed up — will hold the blazer.",
    );

    // delete
    const deleted = await makeRequest(server, { method: "DELETE", url: url(`/${interaction.id}`), actor: admin });
    expect(deleted.status).toBe(200);
    const afterDelete = await makeRequest(server, { method: "GET", url: url(), actor: admin });
    expect((await parseJsonResponse<{ data: Interaction[] }>(afterDelete)).data).toHaveLength(0);
  });

  it("rejects an invalid interaction kind", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: url(),
      body: { kind: "carrier_pigeon", notes: "nope" },
      actor: admin,
    });
    expect([400, 422]).toContain(res.status);
  });
});
