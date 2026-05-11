import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testNoPermActor,
  posAdminActor,
  posOperatorActor,
  posManagerActor,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";

describe("POS Adversarial / Edge Cases", () => {
  let app: PluginTestApp["app"];
  let terminalId: string;
  let shiftId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(posPlugin());
    app = result.app;

    // Setup
    const termRes = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Register A", code: "RA" }),
    });
    terminalId = (await termRes.json()).data.id;

    const shiftRes = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    shiftId = (await shiftRes.json()).data.id;
  }, 30_000);

  // ─── Auth Edge Cases ─────────────────────────────────────────────

  it("unauthenticated terminal create → 401", async () => {
    const res = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", code: "BAD" }),
    });
    expect(res.status).toBe(401);
  });

  it("no-perm actor terminal create → 403", async () => {
    const res = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ name: "Bad", code: "BAD" }),
    });
    expect(res.status).toBe(403);
  });

  it("operator cannot void (requires pos:manage) → 403", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}/void`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ reason: "test" }),
    });
    expect(res.status).toBe(403);
  });

  // ─── Shift Edge Cases ────────────────────────────────────────────

  it("rejects negative opening float → error", async () => {
    // Create a second terminal so we can test
    const termRes = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Register B", code: "RB" }),
    });
    const term2Id = (await termRes.json()).data.id;

    const res = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ terminalId: term2Id, openingFloat: -100 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects cash event on closed shift → error", async () => {
    // Create terminal + shift, close it, then try cash event
    const termRes = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Register C", code: "RC" }),
    });
    const closedTermId = (await termRes.json()).data.id;

    const openRes = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ terminalId: closedTermId, openingFloat: 5000 }),
    });
    const closedShiftId = (await openRes.json()).data.id;

    await app.request(`http://localhost/api/pos/shifts/${closedShiftId}/close`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ closingCount: 5000 }),
    });

    const res = await app.request(`http://localhost/api/pos/shifts/${closedShiftId}/cash-events`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ type: "drop", amount: 1000 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── Transaction Edge Cases ──────────────────────────────────────

  it("cannot hold a completed transaction → error", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    // Complete it first — must succeed
    const completeRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/complete`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
    });
    expect(completeRes.status).toBeLessThan(400);

    // Try to hold the completed transaction
    const holdRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/hold`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ label: "test" }),
    });
    expect(holdRes.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot void a completed transaction → error", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    // Complete it — must succeed
    const completeRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/complete`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
    });
    expect(completeRes.status).toBeLessThan(400);

    // Try to void
    const voidRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/void`, {
      method: "POST",
      headers: jsonHeaders(posManagerActor),
      body: JSON.stringify({ reason: "test" }),
    });
    expect(voidRes.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot recall a non-held transaction → error", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}/recall`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── Terminal Edge Cases ─────────────────────────────────────────

  it("rejects duplicate terminal code in same org → error", async () => {
    const res = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Duplicate", code: "RA" }), // RA already exists
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("deactivates a terminal → 200", async () => {
    const termRes = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "To Deactivate", code: "DEL1" }),
    });
    const delId = (await termRes.json()).data.id;

    const res = await app.request(`http://localhost/api/pos/terminals/${delId}`, {
      method: "DELETE",
      headers: jsonHeaders(posAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isActive).toBe(false);
  });

  // ─── Payment Edge Cases ──────────────────────────────────────────

  it("rejects payment on non-open transaction → error", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    // Void it
    await app.request(`http://localhost/api/pos/transactions/${txnId}/void`, {
      method: "POST",
      headers: jsonHeaders(posManagerActor),
      body: JSON.stringify({ reason: "test" }),
    });

    // Try to add payment to voided transaction
    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}/payments`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ method: "cash", amount: 1000 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
