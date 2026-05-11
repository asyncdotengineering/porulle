import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  posAdminActor,
  posOperatorActor,
  posManagerActor,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";

describe("POS Transaction Lifecycle", () => {
  let app: PluginTestApp["app"];
  let terminalId: string;
  let shiftId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(posPlugin());
    app = result.app;

    // Create terminal
    const termRes = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Register 2", code: "R2" }),
    });
    terminalId = (await termRes.json()).data.id;

    // Open shift
    const shiftRes = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ terminalId, openingFloat: 20000 }),
    });
    shiftId = (await shiftRes.json()).data.id;
  }, 30_000);

  // ─── Create Transaction ──────────────────────────────────────────

  it("starts a new transaction → 201 with cartId", async () => {
    const res = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.cartId).toBeDefined();
    expect(body.data.status).toBe("open");
    expect(body.data.receiptNumber).toMatch(/^R2-\d{4}$/);
  });

  // ─── Hold / Recall ───────────────────────────────────────────────

  it("holds and recalls a transaction", async () => {
    // Create transaction
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    // Hold
    const holdRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/hold`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ label: "John's order" }),
    });
    expect(holdRes.status).toBe(201);
    const holdBody = await holdRes.json();
    expect(holdBody.data.status).toBe("held");
    expect(holdBody.data.holdLabel).toBe("John's order");

    // List held
    const heldRes = await app.request(`http://localhost/api/pos/transactions/held?terminalId=${terminalId}`, {
      headers: jsonHeaders(posOperatorActor),
    });
    expect(heldRes.status).toBe(200);
    const heldBody = await heldRes.json();
    expect(heldBody.data.length).toBeGreaterThanOrEqual(1);

    // Recall
    const recallRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/recall`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
    });
    expect(recallRes.status).toBe(201);
    const recallBody = await recallRes.json();
    expect(recallBody.data.status).toBe("open");
  });

  // ─── Void ────────────────────────────────────────────────────────

  it("voids a transaction with reason → requires pos:manage", async () => {
    // Create transaction
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    // Operator cannot void (no pos:manage)
    const voidRes1 = await app.request(`http://localhost/api/pos/transactions/${txnId}/void`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ reason: "Customer changed mind" }),
    });
    expect(voidRes1.status).toBe(403);

    // Manager can void
    const voidRes2 = await app.request(`http://localhost/api/pos/transactions/${txnId}/void`, {
      method: "POST",
      headers: jsonHeaders(posManagerActor),
      body: JSON.stringify({ reason: "Customer changed mind" }),
    });
    expect(voidRes2.status).toBe(201);
    const body = await voidRes2.json();
    expect(body.data.status).toBe("voided");
    expect(body.data.voidReason).toBe("Customer changed mind");
  });

  // ─── Associate Customer ──────────────────────────────────────────

  it("associates a customer with a transaction", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;
    const customerId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}/customer`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ customerId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.customerId).toBe(customerId);
  });

  // ─── Get Transaction ─────────────────────────────────────────────

  it("gets transaction by id", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}`, {
      headers: jsonHeaders(posOperatorActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(txnId);
  });
});
