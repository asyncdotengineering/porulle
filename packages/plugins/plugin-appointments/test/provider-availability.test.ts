import { describe, expect, it, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testAdminActor,
  testNoPermActor,
} from "./test-utils.js";
import { managerActor } from "./test-utils.js";
import { appointmentPlugin } from "../src/index.js";

describe("provider & availability management (E2E)", () => {
  let app: PluginTestApp["app"];

  beforeAll(async () => {
    const result = await createPluginTestApp(appointmentPlugin());
    app = result.app;
  });

  it("creates service type → 201", async () => {
    const res = await app.request("http://localhost/api/appointments/services", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        name: "Deep Tissue Massage",
        slug: "deep-tissue-massage",
        durationMinutes: 60,
        priceCents: 8000,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.name).toBe("Deep Tissue Massage");
    expect(data.data.durationMinutes).toBe(60);
    expect(data.data.priceCents).toBe(8000);
  });

  it("creates provider → 201", async () => {
    const res = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        name: "Dr. Sarah",
        email: "sarah@clinic.com",
        timezone: "America/New_York",
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.name).toBe("Dr. Sarah");
    expect(data.data.timezone).toBe("America/New_York");
  });

  it("sets weekly availability (Mon-Fri 9-5) → 200", async () => {
    const provRes = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ name: "Availability Test Provider", timezone: "UTC" }),
    });
    const providerId = (await provRes.json()).data.id;

    const res = await app.request(
      `http://localhost/api/appointments/availability/${providerId}/weekly`,
      {
        method: "PUT",
        headers: jsonHeaders(managerActor),
        body: JSON.stringify({
          schedules: [1, 2, 3, 4, 5].map((d) => ({
            dayOfWeek: d,
            startTime: "09:00",
            endTime: "17:00",
          })),
        }),
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toHaveLength(5);
  });

  it("adds break (lunch 12-1) → 201", async () => {
    const provRes = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ name: "Break Test Provider", timezone: "UTC" }),
    });
    const providerId = (await provRes.json()).data.id;

    const res = await app.request(
      `http://localhost/api/appointments/availability/${providerId}/breaks`,
      {
        method: "POST",
        headers: jsonHeaders(managerActor),
        body: JSON.stringify({
          startTime: "12:00",
          endTime: "13:00",
          label: "Lunch",
        }),
      },
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.label).toBe("Lunch");
  });

  it("adds date override (day off Dec 25) → 201", async () => {
    const provRes = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ name: "Override Test Provider", timezone: "UTC" }),
    });
    const providerId = (await provRes.json()).data.id;

    const res = await app.request(
      `http://localhost/api/appointments/availability/${providerId}/overrides`,
      {
        method: "POST",
        headers: jsonHeaders(managerActor),
        body: JSON.stringify({
          date: "2026-12-25",
          isAvailable: false,
          reason: "Christmas Day",
        }),
      },
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.isAvailable).toBe(false);
    expect(data.data.reason).toBe("Christmas Day");
  });

  it("adds working override (Saturday Jan 5 10-2) → 201", async () => {
    const provRes = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ name: "Working Override Provider", timezone: "UTC" }),
    });
    const providerId = (await provRes.json()).data.id;

    const res = await app.request(
      `http://localhost/api/appointments/availability/${providerId}/overrides`,
      {
        method: "POST",
        headers: jsonHeaders(managerActor),
        body: JSON.stringify({
          date: "2027-01-05",
          isAvailable: true,
          startTime: "10:00",
          endTime: "14:00",
          reason: "Special Saturday",
        }),
      },
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.isAvailable).toBe(true);
    expect(data.data.startTime).toBe("10:00");
  });

  it("GET /slots returns filtered slots respecting all rules", async () => {
    // Create full setup
    const svcRes = await app.request("http://localhost/api/appointments/services", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        name: "Slot Test Service",
        slug: "slot-test-service",
        durationMinutes: 30,
        priceCents: 2000,
      }),
    });
    const serviceTypeId = (await svcRes.json()).data.id;

    const provRes = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ name: "Slot Test Provider", timezone: "UTC" }),
    });
    const providerId = (await provRes.json()).data.id;

    await app.request(`http://localhost/api/appointments/providers/${providerId}/services`, {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ serviceTypeId }),
    });

    // Set Mon-Fri 9-5
    await app.request(`http://localhost/api/appointments/availability/${providerId}/weekly`, {
      method: "PUT",
      headers: jsonHeaders(managerActor),
      body: JSON.stringify({
        schedules: [1, 2, 3, 4, 5].map((d) => ({
          dayOfWeek: d,
          startTime: "09:00",
          endTime: "17:00",
        })),
      }),
    });

    // Add lunch break
    await app.request(`http://localhost/api/appointments/availability/${providerId}/breaks`, {
      method: "POST",
      headers: jsonHeaders(managerActor),
      body: JSON.stringify({ startTime: "12:00", endTime: "13:00", label: "Lunch" }),
    });

    // Query slots for a Monday (2026-03-23 is a Monday)
    const res = await app.request(
      `http://localhost/api/appointments/availability/${providerId}/slots?date=2026-03-23&serviceTypeId=${serviceTypeId}`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
    // 16 slots - 2 (lunch break 12:00 and 12:30) = 14
    expect(data.data.length).toBe(14);
  });

  it("permission: only appointments:admin can manage providers", async () => {
    const res = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ name: "Unauthorized Provider" }),
    });
    expect(res.status).toBe(403);
  });

  it("permission: only appointments:manage can set availability", async () => {
    const provRes = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ name: "Perm Test Provider", timezone: "UTC" }),
    });
    const providerId = (await provRes.json()).data.id;

    const res = await app.request(
      `http://localhost/api/appointments/availability/${providerId}/weekly`,
      {
        method: "PUT",
        headers: jsonHeaders(testNoPermActor),
        body: JSON.stringify({
          schedules: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("lists service types publicly", async () => {
    const res = await app.request("http://localhost/api/appointments/services");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
  });

  it("lists providers publicly", async () => {
    const res = await app.request("http://localhost/api/appointments/providers");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
  });

  it("updates a service type", async () => {
    const createRes = await app.request("http://localhost/api/appointments/services", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        name: "Update Test Service",
        slug: "update-test-service",
        durationMinutes: 45,
        priceCents: 5000,
      }),
    });
    const serviceId = (await createRes.json()).data.id;

    const updateRes = await app.request(
      `http://localhost/api/appointments/services/${serviceId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ priceCents: 6000 }),
      },
    );
    expect(updateRes.status).toBe(200);
    const data = await updateRes.json();
    expect(data.data.priceCents).toBe(6000);
  });

  it("deletes a service type", async () => {
    const createRes = await app.request("http://localhost/api/appointments/services", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        name: "Delete Test Service",
        slug: "delete-test-service",
        durationMinutes: 30,
        priceCents: 1000,
      }),
    });
    const serviceId = (await createRes.json()).data.id;

    const deleteRes = await app.request(
      `http://localhost/api/appointments/services/${serviceId}`,
      {
        method: "DELETE",
        headers: jsonHeaders(testAdminActor),
      },
    );
    expect(deleteRes.status).toBe(200);
  });
});
