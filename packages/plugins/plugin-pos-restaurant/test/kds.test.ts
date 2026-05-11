import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp  } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  restaurantAdminActor,
  serverActor,
} from "./test-utils.js";
import { TEST_ORG_ID } from "@porulle/core/testing";
import { posRestaurantPlugin } from "../src/index.js";
import { KDSService } from "../src/services/kds-service.js";
import type { Db } from "../src/types.js";

describe("POS Restaurant KDS", () => {
  let app: PluginTestApp["app"];
  let db: PluginTestApp["db"];
  let kdsService: KDSService;
  let grillStationId: string;
  let barStationId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(posRestaurantPlugin());
    app = result.app;
    db = result.db;
    kdsService = new KDSService(db);

    // Create stations via API
    const grillRes = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "Grill Station", alertThresholdMinutes: 10 }),
    });
    grillStationId = (await grillRes.json()).data.id;

    const barRes = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "Bar" }),
    });
    barStationId = (await barRes.json()).data.id;

    // Assign item groups
    await app.request(`http://localhost/api/pos/restaurant/kds/stations/${grillStationId}/item-groups`, {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ itemGroup: "mains" }),
    });
    await app.request(`http://localhost/api/pos/restaurant/kds/stations/${grillStationId}/item-groups`, {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ itemGroup: "sides" }),
    });
    await app.request(`http://localhost/api/pos/restaurant/kds/stations/${barStationId}/item-groups`, {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ itemGroup: "beverages" }),
    });
  }, 30_000);

  // ─── Station CRUD ────────────────────────────────────────────────

  it("lists stations -> 200", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
      headers: jsonHeaders(serverActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(2);
  });

  it("rejects duplicate station name -> error", async () => {
    const res = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
      method: "POST",
      headers: jsonHeaders(restaurantAdminActor),
      body: JSON.stringify({ name: "Grill Station" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ─── Ticket Generation + Status Flow ─────────────────────────────

  it("routes items to correct stations and tracks status transitions", async () => {
    // Generate tickets with items spanning 2 stations
    const ticketResult = await kdsService.generateTickets(TEST_ORG_ID, {
      transactionId: "d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a",
      items: [
        {
          entityId: "e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b",
          itemName: "Grilled Steak",
          quantity: 1,
          itemGroup: "mains",
          courseName: "Mains",
          coursePriority: 2,
          showCourseLabel: true,
        },
        {
          entityId: "f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c",
          itemName: "Mojito",
          quantity: 2,
          itemGroup: "beverages",
          courseName: "Drinks",
          coursePriority: 1,
        },
      ],
      tableNumber: "T1",
      operatorName: "Server 1",
    });

    expect(ticketResult.ok).toBe(true);
    if (!ticketResult.ok) return;
    expect(ticketResult.value.length).toBe(2);

    const grillTicket = ticketResult.value.find((t) => t.stationId === grillStationId);
    const barTicket = ticketResult.value.find((t) => t.stationId === barStationId);
    expect(grillTicket).toBeDefined();
    expect(barTicket).toBeDefined();
    expect(grillTicket!.type).toBe("new_order");
    expect(grillTicket!.status).toBe("pending");

    // Status transitions: pending -> preparing -> ready -> served
    const started = await kdsService.startTicket(grillTicket!.id);
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.value.status).toBe("preparing");
      expect(started.value.firedAt).toBeDefined();
    }

    const ready = await kdsService.readyTicket(grillTicket!.id);
    expect(ready.ok).toBe(true);
    if (ready.ok) {
      expect(ready.value.status).toBe("ready");
      expect(ready.value.readyAt).toBeDefined();
    }

    const served = await kdsService.serveTicket(grillTicket!.id);
    expect(served.ok).toBe(true);
    if (served.ok) {
      expect(served.value.status).toBe("served");
      expect(served.value.servedAt).toBeDefined();
    }
  });

  it("generates 'modified' ticket type for existing transaction", async () => {
    const txnId = "a1b2c3d4-e5f6-4789-abcd-0e1f2a3b4c5d";

    // First ticket
    const first = await kdsService.generateTickets(TEST_ORG_ID, {
      transactionId: txnId,
      items: [{ entityId: "e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b", itemName: "Steak", quantity: 1, itemGroup: "mains" }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.length).toBe(1);
    expect(first.value[0]!.type).toBe("new_order");

    // Second ticket for same transaction + station
    const second = await kdsService.generateTickets(TEST_ORG_ID, {
      transactionId: txnId,
      items: [{ entityId: "f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c", itemName: "Fries", quantity: 1, itemGroup: "sides" }],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.length).toBe(1);
    expect(second.value[0]!.type).toBe("modified");
  });

  // ─── Item-Level Status ───────────────────────────────────────────

  it("marks individual ticket item as done", async () => {
    const ticketResult = await kdsService.generateTickets(TEST_ORG_ID, {
      transactionId: "b2c3d4e5-f6a7-4b89-abcd-1f2a3b4c5d6e",
      items: [{ entityId: "e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b", itemName: "Burger", quantity: 1, itemGroup: "mains" }],
    });

    expect(ticketResult.ok).toBe(true);
    if (!ticketResult.ok) return;
    const ticket = ticketResult.value[0]!;

    // Get ticket with items via pending list
    const pending = await kdsService.listPendingTickets(TEST_ORG_ID, grillStationId);
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;

    const ticketWithItems = pending.value.find((t) => t.id === ticket.id);
    expect(ticketWithItems).toBeDefined();
    expect(ticketWithItems!.items.length).toBe(1);

    const itemId = ticketWithItems!.items[0]!.id;
    const doneResult = await kdsService.markItemDone(ticket.id, itemId);
    expect(doneResult.ok).toBe(true);
    if (doneResult.ok) expect(doneResult.value.status).toBe("done");
  });

  // ─── Pending Tickets API ─────────────────────────────────────────

  it("lists pending tickets for station via API -> 200", async () => {
    const res = await app.request(`http://localhost/api/pos/restaurant/kds/stations/${grillStationId}/tickets`, {
      headers: jsonHeaders(serverActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});
