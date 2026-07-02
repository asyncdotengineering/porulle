import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  posAdminActor,
  posOperatorActor,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";

// Issue #51 — config.auth.posPin existed with no runtime behind it: no PIN
// login, no per-shift credential minting, no manager override. POS apps
// hand-rolled scrypt hashes and synthetic API keys through module-global auth
// holders. The plugin now ships the runtime: PIN set/rotate, PIN login that
// mints a short-lived Better Auth API key bound to the operator's open
// shift, and manager-override-by-PIN.
describe("POS PIN auth runtime (issue #51)", () => {
  let app: PluginTestApp["app"];
  let terminalId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(posPlugin());
    app = result.app;

    const res = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Register 1", code: "R1" }),
    });
    terminalId = (await res.json()).data.id;

    // Admin provisions PINs: cashier (no override) + manager (canOverride)
    for (const [operatorId, pin, canOverride] of [
      ["pos-operator-1", "4321", false],
      ["pos-manager-1", "9876", true],
    ] as const) {
      const pinRes = await app.request("http://localhost/api/pos/auth/pin", {
        method: "PUT",
        headers: jsonHeaders(posAdminActor),
        body: JSON.stringify({ operatorId, pin, canOverride }),
      });
      expect(pinRes.status).toBe(200);
    }
  }, 30_000);

  it("rejects PIN set from a non-admin", async () => {
    const res = await app.request("http://localhost/api/pos/auth/pin", {
      method: "PUT",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-operator-1", pin: "1111" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("PIN login requires an open shift, then mints a working per-shift credential", async () => {
    // No open shift yet → rejected
    const early = await app.request("http://localhost/api/pos/auth/pin-login", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-operator-1", pin: "4321" }),
    });
    expect(early.status).toBeGreaterThanOrEqual(400);

    // Open a shift for the cashier
    const shiftRes = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    expect(shiftRes.status).toBe(201);
    const shiftId = (await shiftRes.json()).data.id;

    // Wrong PIN → rejected
    const wrong = await app.request("http://localhost/api/pos/auth/pin-login", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-operator-1", pin: "0000" }),
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    // Right PIN → shift-bound credential
    const login = await app.request("http://localhost/api/pos/auth/pin-login", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-operator-1", pin: "4321" }),
    });
    expect(login.status).toBe(201);
    const cred = (await login.json()).data;
    expect(cred.shiftId).toBe(shiftId);
    expect(cred.terminalId).toBe(terminalId);
    expect(typeof cred.apiKey).toBe("string");

    // The minted key authenticates a POS route with NO test actor —
    // it flows through the real Better Auth middleware.
    const current = await app.request("http://localhost/api/pos/shifts/current", {
      method: "GET",
      headers: { "x-api-key": cred.apiKey },
    });
    expect(current.status).toBe(200);
    const currentShift = (await current.json()).data;
    expect(currentShift.id).toBe(shiftId);
  });

  it("manager override approves by PIN; a non-override PIN is rejected", async () => {
    const approved = await app.request("http://localhost/api/pos/auth/override", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-manager-1", pin: "9876", action: "refund-over-cap" }),
    });
    expect(approved.status).toBe(201);
    const body = (await approved.json()).data;
    expect(body.approved).toBe(true);
    expect(body.action).toBe("refund-over-cap");

    const denied = await app.request("http://localhost/api/pos/auth/override", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-operator-1", pin: "4321", action: "refund-over-cap" }),
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it("rotating a PIN invalidates the old one", async () => {
    await app.request("http://localhost/api/pos/auth/pin", {
      method: "PUT",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ operatorId: "pos-manager-1", pin: "1357" }),
    });
    const oldPin = await app.request("http://localhost/api/pos/auth/override", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-manager-1", pin: "9876", action: "void" }),
    });
    expect(oldPin.status).toBeGreaterThanOrEqual(400);

    const newPin = await app.request("http://localhost/api/pos/auth/override", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ operatorId: "pos-manager-1", pin: "1357", action: "void" }),
    });
    expect(newPin.status).toBe(201);
    // canOverride persists across rotation when not specified
    expect((await newPin.json()).data.approved).toBe(true);
  });
});
