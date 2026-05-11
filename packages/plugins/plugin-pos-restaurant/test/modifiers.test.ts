import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testNoPermActor,
  restaurantAdminActor,
  serverActor,
} from "./test-utils.js";
import { posRestaurantPlugin } from "../src/index.js";

describe("POS Restaurant Modifiers", () => {
  let app: PluginTestApp["app"];

  beforeAll(async () => {
    const result = await createPluginTestApp(posRestaurantPlugin());
    app = result.app;
  }, 30_000);

  // ─── Modifier Group CRUD ─────────────────────────────────────────

  it("creates a modifier group with required=true, minSelect=1, maxSelect=2 -> 201", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({
        name: "Choose your protein",
        isRequired: true,
        minSelect: 1,
        maxSelect: 2,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe("Choose your protein");
    expect(body.data.isRequired).toBe(true);
    expect(body.data.minSelect).toBe(1);
    expect(body.data.maxSelect).toBe(2);
  });

  it("rejects minSelect > maxSelect -> error", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({
        name: "Invalid",
        minSelect: 5,
        maxSelect: 2,
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("lists modifier groups -> 200", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      headers: jsonHeaders(serverActor),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Modifier Options ────────────────────────────────────────────

  it("adds options to a group with price adjustments -> 201", async () => {
    // Create a group first
    const groupRes = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "Add toppings", maxSelect: 5 }),
    });
    const groupId = (await groupRes.json()).data.id;

    // Add options
    const opt1 = await app.request(`http://localhost/api/pos/restaurant/modifier-groups/${groupId}/options`, {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "Extra cheese", priceAdjustment: 150 }),
    });
    expect(opt1.status).toBe(201);
    const opt1Body = await opt1.json();
    expect(opt1Body.data.priceAdjustment).toBe(150);

    const opt2 = await app.request(`http://localhost/api/pos/restaurant/modifier-groups/${groupId}/options`, {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "No onions", priceAdjustment: 0 }),
    });
    expect(opt2.status).toBe(201);
  });

  it("gets group with options -> 200", async () => {
    // Find the "Add toppings" group
    const listRes = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      headers: jsonHeaders(serverActor),
    });
    const groups = (await listRes.json()).data;
    const toppingsGroup = groups.find((g: { name: string }) => g.name === "Add toppings");

    const res = await app.request(`http://localhost/api/pos/restaurant/modifier-groups/${toppingsGroup.id}`, {
      headers: jsonHeaders(serverActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.group.name).toBe("Add toppings");
    expect(body.data.options.length).toBe(2);
  });

  // ─── Auth ────────────────────────────────────────────────────────

  it("rejects unauthenticated modifier creation -> 401", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects no-permission actor -> 403", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      method: "POST",
      headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ name: "Test" }),
    });
    expect(res.status).toBe(403);
  });

  // ─── Delete ──────────────────────────────────────────────────────

  it("deletes a modifier group (cascades options) -> 200", async () => {
    // Create group + option
    const groupRes = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "To Delete" }),
    });
    const groupId = (await groupRes.json()).data.id;

    await app.request(`http://localhost/api/pos/restaurant/modifier-groups/${groupId}/options`, {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "Option 1" }),
    });

    // Delete group
    const delRes = await app.request(`http://localhost/api/pos/restaurant/modifier-groups/${groupId}`, {
      method: "DELETE",
      headers: jsonHeaders(restaurantAdminActor),
    });
    expect(delRes.status).toBe(200);
  });
});
