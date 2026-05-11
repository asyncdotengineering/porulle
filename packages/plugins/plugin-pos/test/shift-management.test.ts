import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testAdminActor,
  testNoPermActor,
  posAdminActor,
  posOperatorActor,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";

describe("POS Shift Management", () => {
  let app: PluginTestApp["app"];
  let terminalId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(posPlugin());
    app = result.app;

    // Create a terminal for shift tests
    const res = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Register 1", code: "R1" }),
    });
    const body = await res.json();
    terminalId = body.data.id;
  }, 30_000);

  // ─── Open Shift ──────────────────────────────────────────────────

  it("opens a shift with opening float → 201", async () => {
    const res = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({
        terminalId,
        openingFloat: 20000, // $200
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("open");
    expect(body.data.openingFloat).toBe(20000);
    expect(body.data.operatorId).toBe("pos-operator-1");
  });

  it("rejects opening a second shift on the same terminal → error", async () => {
    const res = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({
        terminalId,
        openingFloat: 10000,
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── Get Current Shift ───────────────────────────────────────────

  it("gets current open shift → 200", async () => {
    const res = await app.request("http://localhost/api/pos/shifts/current", {
      headers: jsonHeaders(posOperatorActor),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).not.toBeNull();
    expect(body.data.status).toBe("open");
  });

  // ─── Cash Events ─────────────────────────────────────────────────

  it("records a cash drop → 201", async () => {
    // Get shift ID first
    const shiftRes = await app.request("http://localhost/api/pos/shifts/current", {
      headers: jsonHeaders(posOperatorActor),
    });
    const shiftBody = await shiftRes.json();
    const shiftId = shiftBody.data.id;

    const res = await app.request(`http://localhost/api/pos/shifts/${shiftId}/cash-events`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({
        type: "drop",
        amount: 5000, // $50 bank deposit
        reason: "Bank deposit",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe("drop");
    expect(body.data.amount).toBe(5000);
  });

  it("lists cash events for a shift → 200", async () => {
    const shiftRes = await app.request("http://localhost/api/pos/shifts/current", {
      headers: jsonHeaders(posOperatorActor),
    });
    const shiftBody = await shiftRes.json();
    const shiftId = shiftBody.data.id;

    const res = await app.request(`http://localhost/api/pos/shifts/${shiftId}/cash-events`, {
      headers: jsonHeaders(posOperatorActor),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Close Shift ─────────────────────────────────────────────────

  it("closes shift with cash count, calculates variance → 201", async () => {
    const shiftRes = await app.request("http://localhost/api/pos/shifts/current", {
      headers: jsonHeaders(posOperatorActor),
    });
    const shiftBody = await shiftRes.json();
    const shiftId = shiftBody.data.id;

    const res = await app.request(`http://localhost/api/pos/shifts/${shiftId}/close`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({
        closingCount: 15500, // $155 counted
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("closed");
    expect(body.data.closingCount).toBe(15500);
    expect(body.data.expectedCash).toBeDefined();
    expect(body.data.cashVariance).toBeDefined();
  });

  // ─── Z-Report ────────────────────────────────────────────────────

  it("generates Z-report for closed shift → 200", async () => {
    // Need to find the closed shift
    const shiftRes = await app.request("http://localhost/api/pos/shifts/current", {
      headers: jsonHeaders(posOperatorActor),
    });
    // Current will be null since we closed it, so get by ID instead
    // Open a new shift, close it, and get report

    // First open a new shift
    const openRes = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    const openBody = await openRes.json();
    const shiftId = openBody.data.id;

    // Close it
    await app.request(`http://localhost/api/pos/shifts/${shiftId}/close`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ closingCount: 10000 }),
    });

    // Get report
    const reportRes = await app.request(`http://localhost/api/pos/shifts/${shiftId}/report`, {
      headers: jsonHeaders(posAdminActor),
    });

    expect(reportRes.status).toBe(200);
    const body = await reportRes.json();
    expect(body.data.shift).toBeDefined();
    expect(body.data.cashEvents).toBeDefined();
    expect(body.data.paymentMethodTotals).toBeDefined();
    expect(body.data.transactionCount).toBeDefined();
  });

  // ─── Auth ────────────────────────────────────────────────────────

  it("rejects unauthenticated shift open → 401", async () => {
    const res = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects no-permission actor → 403", async () => {
    const res = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    expect(res.status).toBe(403);
  });
});
