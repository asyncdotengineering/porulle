import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "@porulle/core/drizzle";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  posAdminActor,
  posOperatorActor,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";
import { posPinAttempts } from "../src/schema.js";

const LOCKED_OPERATOR = "pos-operator-sec15-locked";
const RECOVER_OPERATOR = "pos-operator-sec15-recover";
const OPERATOR_PIN = "5544";

async function attemptOverride(
  app: PluginTestApp["app"],
  operatorId: string,
  pin: string,
) {
  return app.request("http://localhost/api/pos/auth/override", {
    method: "POST",
    headers: jsonHeaders(posOperatorActor),
    body: JSON.stringify({ operatorId, pin, action: "sec15-test" }),
  });
}

describe("SEC-15 — per-operator PIN brute-force lockout", () => {
  let app: PluginTestApp["app"];
  let db: PluginTestApp["db"];
  let terminalId: string;

  beforeAll(async () => {
    const built = await createPluginTestApp(posPlugin());
    app = built.app;
    db = built.db;

    const terminalRes = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "SEC-15 Register", code: "SEC15" }),
    });
    terminalId = (await terminalRes.json()).data.id;

    for (const operatorId of [LOCKED_OPERATOR, RECOVER_OPERATOR]) {
      const pinRes = await app.request("http://localhost/api/pos/auth/pin", {
        method: "PUT",
        headers: jsonHeaders(posAdminActor),
        body: JSON.stringify({ operatorId, pin: OPERATOR_PIN, canOverride: true }),
      });
      expect(pinRes.status).toBe(200);
    }
  }, 30_000);

  it("locks out after repeated failures and rejects the correct PIN during lockout", async () => {
    for (let i = 0; i < 5; i++) {
      const failed = await attemptOverride(app, LOCKED_OPERATOR, "0000");
      expect(failed.status).toBeGreaterThanOrEqual(400);
    }

    const locked = await attemptOverride(app, LOCKED_OPERATOR, OPERATOR_PIN);
    expect(locked.status).toBeGreaterThanOrEqual(400);
    const lockedBody = await locked.json();
    expect(lockedBody.error.message).toContain("Too many failed PIN attempts");

    const shiftRes = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders({
        ...posOperatorActor,
        userId: LOCKED_OPERATOR,
        email: "sec15-locked@test.local",
        name: "SEC-15 Locked",
      }),
      body: JSON.stringify({ terminalId, openingFloat: 1000 }),
    });
    expect(shiftRes.status).toBe(201);

    const pinLogin = await app.request("http://localhost/api/pos/auth/pin-login", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: LOCKED_OPERATOR, pin: OPERATOR_PIN }),
    });
    expect(pinLogin.status).toBeGreaterThanOrEqual(400);
    const pinLoginBody = await pinLogin.json();
    expect(pinLoginBody.error.message).toContain("Too many failed PIN attempts");
  });

  it("allows login after lockout expiry and clears the counter on success", async () => {
    for (let i = 0; i < 5; i++) {
      const failed = await attemptOverride(app, RECOVER_OPERATOR, "0000");
      expect(failed.status).toBeGreaterThanOrEqual(400);
    }

    const locked = await attemptOverride(app, RECOVER_OPERATOR, OPERATOR_PIN);
    expect(locked.status).toBeGreaterThanOrEqual(400);

    await db
      .update(posPinAttempts)
      .set({ lockedUntil: new Date(Date.now() - 60_000) })
      .where(and(
        eq(posPinAttempts.organizationId, posOperatorActor.organizationId),
        eq(posPinAttempts.operatorId, RECOVER_OPERATOR),
      ));

    const recovered = await attemptOverride(app, RECOVER_OPERATOR, OPERATOR_PIN);
    expect(recovered.status).toBe(201);
    expect((await recovered.json()).data.approved).toBe(true);

    const rows = await db
      .select()
      .from(posPinAttempts)
      .where(and(
        eq(posPinAttempts.organizationId, posOperatorActor.organizationId),
        eq(posPinAttempts.operatorId, RECOVER_OPERATOR),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failedCount).toBe(0);
    expect(rows[0]!.lockedUntil).toBeNull();
  });
});