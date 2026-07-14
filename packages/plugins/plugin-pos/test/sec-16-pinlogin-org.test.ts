import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "@porulle/core/drizzle";
import { apikey, organization } from "@porulle/core/auth-schema";
import type { PluginTestApp } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  posAdminActor,
  TEST_ORG_ID,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";
import { DEFAULT_ORG_ID } from "@porulle/core";
import { posShifts } from "../src/schema.js";

const STORE_ORG_ID = "org_pos_store_sec16";

describe("SEC-16 — pin-login API key carries operator organization", () => {
  let app: PluginTestApp["app"];
  let db: PluginTestApp["db"];
  let terminalId: string;

  const storeAdmin: Actor = {
    ...posAdminActor,
    organizationId: STORE_ORG_ID,
  };

  const storeOperator: Actor = {
    type: "user",
    userId: "pos-operator-sec16",
    email: "sec16-cashier@test.local",
    name: "SEC-16 Cashier",
    vendorId: null,
    organizationId: STORE_ORG_ID,
    role: "staff",
    permissions: ["pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
  };

  beforeAll(async () => {
    const built = await createPluginTestApp(posPlugin());
    app = built.app;
    db = built.db;

    await db.insert(organization).values({
      id: STORE_ORG_ID,
      name: "SEC-16 Store",
      slug: "sec16-store",
      createdAt: new Date(),
    });

    const res = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(storeAdmin),
      body: JSON.stringify({ name: "SEC-16 Register", code: "SEC16" }),
    });
    terminalId = (await res.json()).data.id;

    const pinRes = await app.request("http://localhost/api/pos/auth/pin", {
      method: "PUT",
      headers: jsonHeaders(storeAdmin),
      body: JSON.stringify({ operatorId: storeOperator.userId, pin: "2468" }),
    });
    expect(pinRes.status).toBe(200);
  }, 30_000);

  it("persists the operator store on the minted key and authenticates with that org", async () => {
    const shiftRes = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(storeOperator),
      body: JSON.stringify({ terminalId, openingFloat: 5000 }),
    });
    expect(shiftRes.status).toBe(201);
    const shiftId = (await shiftRes.json()).data.id;

    const login = await app.request("http://localhost/api/pos/auth/pin-login", {
      method: "POST",
      headers: jsonHeaders(storeOperator),
      body: JSON.stringify({ operatorId: storeOperator.userId, pin: "2468" }),
    });
    expect(login.status).toBe(201);
    const cred = (await login.json()).data;

    const shiftRows = await db
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    const apiKeyId = (shiftRows[0]?.metadata as { pinLoginApiKeyId?: string } | null)
      ?.pinLoginApiKeyId;
    expect(apiKeyId).toBeTruthy();

    const keyRows = await db
      .select()
      .from(apikey)
      .where(eq(apikey.id, apiKeyId!));
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]!.referenceId).toBe(STORE_ORG_ID);
    expect(keyRows[0]!.referenceId).not.toBe(storeOperator.userId);
    expect(keyRows[0]!.referenceId).not.toBe(DEFAULT_ORG_ID);

    const current = await app.request("http://localhost/api/pos/shifts/current", {
      method: "GET",
      headers: { "x-api-key": cred.apiKey },
    });
    expect(current.status).toBe(200);
    const currentShift = (await current.json()).data;
    expect(currentShift.id).toBe(shiftId);

    // Default org exists for the harness but must differ from the operator's store.
    expect(TEST_ORG_ID).toBe(DEFAULT_ORG_ID);
    expect(STORE_ORG_ID).not.toBe(DEFAULT_ORG_ID);
  });
});