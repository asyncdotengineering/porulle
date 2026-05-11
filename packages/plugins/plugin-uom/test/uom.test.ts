import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, testNoPermActor, uomAdminActor, uomReaderActor } from "./test-utils.js";
import { uomPlugin } from "../src/index.js";

describe("UOM Plugin", () => {
  let app: PluginTestApp["app"];
  let kgId: string, gId: string, pcId: string, caseId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(uomPlugin());
    app = result.app;
  }, 30_000);

  it("creates units: kg, g, pc, case -> 201", async () => {
    for (const [code, name, cat] of [["kg", "Kilogram", "weight"], ["g", "Gram", "weight"], ["pc", "Piece", "count"], ["case", "Case", "count"]] as const) {
      const res = await app.request("http://localhost/api/uom/units", {
        method: "POST", headers: jsonHeaders(uomAdminActor),
        body: JSON.stringify({ code, name, category: cat }),
      });
      expect(res.status).toBe(201);
      const id = (await res.json()).data.id;
      if (code === "kg") kgId = id;
      if (code === "g") gId = id;
      if (code === "pc") pcId = id;
      if (code === "case") caseId = id;
    }
  });

  it("rejects duplicate unit code -> error", async () => {
    const res = await app.request("http://localhost/api/uom/units", {
      method: "POST", headers: jsonHeaders(uomAdminActor),
      body: JSON.stringify({ code: "kg", name: "Dup", category: "weight" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("lists units filtered by category -> 200", async () => {
    const res = await app.request("http://localhost/api/uom/units?category=weight", {
      headers: jsonHeaders(uomReaderActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(2);
  });

  it("creates conversion 1kg = 1000g (factor=10000000) -> 201", async () => {
    const res = await app.request("http://localhost/api/uom/conversions", {
      method: "POST", headers: jsonHeaders(uomAdminActor),
      body: JSON.stringify({ fromUnitId: kgId, toUnitId: gId, factor: 10000000 }),
    });
    expect(res.status).toBe(201);
  });

  it("creates conversion 1 case = 24 pc -> 201", async () => {
    const res = await app.request("http://localhost/api/uom/conversions", {
      method: "POST", headers: jsonHeaders(uomAdminActor),
      body: JSON.stringify({ fromUnitId: caseId, toUnitId: pcId, factor: 240000 }),
    });
    expect(res.status).toBe(201);
  });

  it("converts 2.5kg -> 2500g", async () => {
    const res = await app.request("http://localhost/api/uom/convert", {
      method: "POST", headers: jsonHeaders(uomReaderActor),
      body: JSON.stringify({ fromUnitId: kgId, toUnitId: gId, quantity: 25000 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.result).toBe(25000000);
  });

  it("converts 3 cases -> 72 pc", async () => {
    const res = await app.request("http://localhost/api/uom/convert", {
      method: "POST", headers: jsonHeaders(uomReaderActor),
      body: JSON.stringify({ fromUnitId: caseId, toUnitId: pcId, quantity: 3 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.result).toBe(72);
  });

  it("reverse converts g -> kg", async () => {
    const res = await app.request("http://localhost/api/uom/convert", {
      method: "POST", headers: jsonHeaders(uomReaderActor),
      body: JSON.stringify({ fromUnitId: gId, toUnitId: kgId, quantity: 1000 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // 1000g / (10000000/10000) = 1000 / 1000 = 1 kg
    expect(body.data.result).toBe(1);
  });

  it("sets entity UOM assignment -> 201", async () => {
    const entityId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const res = await app.request(`http://localhost/api/uom/entities/${entityId}/uom`, {
      method: "POST", headers: jsonHeaders(uomAdminActor),
      body: JSON.stringify({ purchaseUomId: caseId, stockUomId: pcId, saleUomId: pcId, yieldPercentage: 60 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.yieldPercentage).toBe(60);
  });

  it("gets entity UOM -> 200", async () => {
    const entityId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const res = await app.request(`http://localhost/api/uom/entities/${entityId}/uom`, {
      headers: jsonHeaders(uomReaderActor),
    });
    expect(res.status).toBe(200);
  });

  it("no permission -> 403", async () => {
    const res = await app.request("http://localhost/api/uom/units", {
      method: "POST", headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ code: "x", name: "x", category: "weight" }),
    });
    expect(res.status).toBe(403);
  });

  it("org isolation: different org sees 0 units", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff", permissions: ["uom:read"],
    };
    const res = await app.request("http://localhost/api/uom/units", { headers: jsonHeaders(otherOrg) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });
});
