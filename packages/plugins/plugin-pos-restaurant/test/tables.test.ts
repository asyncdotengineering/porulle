import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  restaurantAdminActor,
  serverActor,
} from "./test-utils.js";
import { posRestaurantPlugin } from "../src/index.js";

describe("POS Restaurant Tables", () => {
  let app: PluginTestApp["app"];

  beforeAll(async () => {
    const result = await createPluginTestApp(posRestaurantPlugin());
    app = result.app;
  }, 30_000);

  // ─── Table CRUD ──────────────────────────────────────────────────

  it("creates tables across zones -> 201", async () => {
    const t1 = await app.request("http://localhost/api/pos/restaurant/tables", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ number: "T1", zone: "Main Hall", capacity: 4, shape: "square" }),
    });
    expect(t1.status).toBe(201);
    expect((await t1.json()).data.status).toBe("available");

    const t2 = await app.request("http://localhost/api/pos/restaurant/tables", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ number: "T2", zone: "Main Hall", capacity: 6, shape: "rectangle" }),
    });
    expect(t2.status).toBe(201);

    const p1 = await app.request("http://localhost/api/pos/restaurant/tables", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ number: "P1", zone: "Patio", capacity: 2, shape: "circle" }),
    });
    expect(p1.status).toBe(201);
  });

  it("rejects duplicate table number -> error", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/tables", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ number: "T1", zone: "Main Hall" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("lists zones with counts -> 200", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/tables/zones", {
      headers: jsonHeaders(serverActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(2);
    const mainHall = body.data.find((z: { zone: string }) => z.zone === "Main Hall");
    expect(mainHall.count).toBe(2);
  });

  it("lists tables filtered by zone -> 200", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/tables?zone=Patio", {
      headers: jsonHeaders(serverActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].number).toBe("P1");
  });

  // ─── Table Assignment ────────────────────────────────────────────

  it("assigns table to transaction -> occupied", async () => {
    // Get T1 ID
    const listRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Main+Hall", {
      headers: jsonHeaders(serverActor),
    });
    const tables = (await listRes.json()).data;
    const t1 = tables.find((t: { number: string }) => t.number === "T1");

    const txnId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request(`http://localhost/api/pos/restaurant/tables/${t1.id}/assign`, {
      method: "POST",
      headers: jsonHeaders(serverActor),
      body: JSON.stringify({ transactionId: txnId }),
    });
    expect(res.status).toBe(201);

    // Verify table is now occupied
    const checkRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Main+Hall", {
      headers: jsonHeaders(serverActor),
    });
    const updated = (await checkRes.json()).data.find((t: { number: string }) => t.number === "T1");
    expect(updated.status).toBe("occupied");
  });

  it("rejects assigning an already-occupied table -> error", async () => {
    const listRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Main+Hall", {
      headers: jsonHeaders(serverActor),
    });
    const t1 = (await listRes.json()).data.find((t: { number: string }) => t.number === "T1");

    const res = await app.request(`http://localhost/api/pos/restaurant/tables/${t1.id}/assign`, {
      method: "POST",
      headers: jsonHeaders(serverActor),
      body: JSON.stringify({ transactionId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── Table Clear ─────────────────────────────────────────────────

  it("clears a table -> available", async () => {
    const listRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Main+Hall", {
      headers: jsonHeaders(serverActor),
    });
    const t1 = (await listRes.json()).data.find((t: { number: string }) => t.number === "T1");

    const res = await app.request(`http://localhost/api/pos/restaurant/tables/${t1.id}/clear`, {
      method: "POST",
      headers: jsonHeaders(serverActor),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("available");
  });

  // ─── Table Transfer ──────────────────────────────────────────────

  it("transfers between tables in same zone", async () => {
    const listRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Main+Hall", {
      headers: jsonHeaders(serverActor),
    });
    const tables = (await listRes.json()).data;
    const t1 = tables.find((t: { number: string }) => t.number === "T1");
    const t2 = tables.find((t: { number: string }) => t.number === "T2");

    // Assign T1
    const txnId = "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f";
    await app.request(`http://localhost/api/pos/restaurant/tables/${t1.id}/assign`, {
      method: "POST",
      headers: jsonHeaders(serverActor),
      body: JSON.stringify({ transactionId: txnId }),
    });

    // Transfer T1 -> T2
    const transferRes = await app.request(`http://localhost/api/pos/restaurant/tables/${t1.id}/transfer`, {
      method: "POST",
      headers: jsonHeaders(serverActor),
      body: JSON.stringify({ toTableId: t2.id }),
    });
    expect(transferRes.status).toBe(201);
    const body = await transferRes.json();
    expect(body.data.from.status).toBe("available");
    expect(body.data.to.status).toBe("occupied");
  });

  it("rejects transfer across zones -> error", async () => {
    const hallRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Main+Hall", {
      headers: jsonHeaders(serverActor),
    });
    const t2 = (await hallRes.json()).data.find((t: { number: string }) => t.number === "T2");

    const patioRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Patio", {
      headers: jsonHeaders(serverActor),
    });
    const p1 = (await patioRes.json()).data.find((t: { number: string }) => t.number === "P1");

    const res = await app.request(`http://localhost/api/pos/restaurant/tables/${t2.id}/transfer`, {
      method: "POST",
      headers: jsonHeaders(serverActor),
      body: JSON.stringify({ toTableId: p1.id }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── Floor Plan Layout ───────────────────────────────────────────

  it("updates floor plan position -> 201", async () => {
    const listRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Patio", {
      headers: jsonHeaders(serverActor),
    });
    const p1 = (await listRes.json()).data[0];

    const res = await app.request(`http://localhost/api/pos/restaurant/tables/${p1.id}/layout`, {
      method: "PATCH",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ layoutX: 250, layoutY: 150, layoutWidth: 120, layoutHeight: 120 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.layoutX).toBe(250);
    expect(body.data.layoutY).toBe(150);
  });
});
