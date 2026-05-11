import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  posAdminActor,
  posOperatorActor,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";

describe("POS Split Payment", () => {
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
      body: JSON.stringify({ name: "Register 3", code: "R3" }),
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

  it("accepts split payment: $20 cash + $15 card on $35 total", async () => {
    // Create transaction
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    // Add cash payment ($20)
    const cashRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/payments`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({
        method: "cash",
        amount: 2000,
      }),
    });
    expect(cashRes.status).toBe(201);
    const cashBody = await cashRes.json();
    expect(cashBody.data.method).toBe("cash");
    expect(cashBody.data.amount).toBe(2000);

    // Add card payment ($15)
    const cardRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/payments`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({
        method: "card",
        amount: 1500,
        reference: "****1234",
      }),
    });
    expect(cardRes.status).toBe(201);
    const cardBody = await cardRes.json();
    expect(cardBody.data.method).toBe("card");
    expect(cardBody.data.amount).toBe(1500);
    expect(cardBody.data.reference).toBe("****1234");
  });

  it("tracks cash change given", async () => {
    // Create transaction
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    // Customer pays $50 cash for $35 item → $15 change
    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}/payments`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({
        method: "cash",
        amount: 5000,
        changeGiven: 1500,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.amount).toBe(5000);
    expect(body.data.changeGiven).toBe(1500);
  });

  it("rejects negative payment amount → error", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}/payments`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ method: "cash", amount: -100 }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects zero payment amount → error", async () => {
    const createRes = await app.request("http://localhost/api/pos/transactions", {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ shiftId, terminalId }),
    });
    const txnId = (await createRes.json()).data.id;

    const res = await app.request(`http://localhost/api/pos/transactions/${txnId}/payments`, {
      method: "POST",
      headers: jsonHeaders(posOperatorActor),
      body: JSON.stringify({ method: "cash", amount: 0 }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
