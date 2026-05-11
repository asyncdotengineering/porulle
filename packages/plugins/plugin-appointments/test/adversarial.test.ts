import { describe, expect, it, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testAdminActor,
  testNoPermActor,
} from "./test-utils.js";
import { customerActor } from "./test-utils.js";
import { appointmentPlugin } from "../src/index.js";

describe("adversarial tests", () => {
  let app: PluginTestApp["app"];
  let providerId: string;
  let serviceTypeId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(appointmentPlugin());
    app = result.app;

    const svcRes = await app.request("http://localhost/api/appointments/services", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        name: "Adversarial Service",
        slug: "adversarial-service",
        durationMinutes: 30,
        priceCents: 5000,
      }),
    });
    serviceTypeId = (await svcRes.json()).data.id;

    const provRes = await app.request("http://localhost/api/appointments/providers", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ name: "Adversarial Provider", timezone: "UTC" }),
    });
    providerId = (await provRes.json()).data.id;

    await app.request(`http://localhost/api/appointments/availability/${providerId}/weekly`, {
      method: "PUT",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        schedules: [1, 2, 3, 4, 5].map((d) => ({
          dayOfWeek: d,
          startTime: "09:00",
          endTime: "17:00",
        })),
      }),
    });
  });

  // ─── Authorization Bypass Attempts ──────────────────────────────────────────

  describe("authorization bypass attempts", () => {
    it("customer cannot create service types", async () => {
      const res = await app.request("http://localhost/api/appointments/services", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({ name: "Hacked", slug: "hacked", durationMinutes: 30, priceCents: 0 }),
      });
      expect(res.status).toBe(403);
    });

    it("customer cannot delete service types", async () => {
      const res = await app.request(
        `http://localhost/api/appointments/services/${serviceTypeId}`,
        { method: "DELETE", headers: jsonHeaders(customerActor) },
      );
      expect(res.status).toBe(403);
    });

    it("customer cannot create providers", async () => {
      const res = await app.request("http://localhost/api/appointments/providers", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({ name: "Hacked Provider" }),
      });
      expect(res.status).toBe(403);
    });

    it("customer cannot confirm bookings", async () => {
      const createRes = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "2026-03-23T09:00:00Z",
          customerName: "Auth Test",
          customerEmail: "auth@test.com",
          paymentMethod: "cash",
        }),
      });
      const booking = (await createRes.json()).data.booking;

      const res = await app.request(
        `http://localhost/api/appointments/bookings/${booking.id}/confirm`,
        { method: "POST", headers: jsonHeaders(customerActor) },
      );
      expect(res.status).toBe(403);
    });

    it("customer cannot mark no-show", async () => {
      const res = await app.request(
        `http://localhost/api/appointments/bookings/00000000-0000-0000-0000-000000000000/no-show`,
        { method: "POST", headers: jsonHeaders(customerActor) },
      );
      expect(res.status).toBe(403);
    });

    it("no-perm user cannot set availability", async () => {
      const res = await app.request(
        `http://localhost/api/appointments/availability/${providerId}/weekly`,
        {
          method: "PUT",
          headers: jsonHeaders(testNoPermActor),
          body: JSON.stringify({ schedules: [{ dayOfWeek: 6, startTime: "10:00", endTime: "14:00" }] }),
        },
      );
      expect(res.status).toBe(403);
    });

    it("no-perm user cannot add breaks", async () => {
      const res = await app.request(
        `http://localhost/api/appointments/availability/${providerId}/breaks`,
        {
          method: "POST",
          headers: jsonHeaders(testNoPermActor),
          body: JSON.stringify({ startTime: "12:00", endTime: "13:00" }),
        },
      );
      expect(res.status).toBe(403);
    });

    it("unauthenticated user cannot create bookings", async () => {
      const res = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "2026-03-23T10:00:00Z",
          customerName: "Anon",
          customerEmail: "anon@test.com",
          paymentMethod: "cash",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("unauthenticated user cannot list their bookings", async () => {
      const res = await app.request("http://localhost/api/appointments/my-bookings");
      expect(res.status).toBe(401);
    });
  });

  // ─── Input Validation Attacks ───────────────────────────────────────────────

  describe("input validation attacks", () => {
    it("rejects empty body on service creation", async () => {
      const res = await app.request("http://localhost/api/appointments/services", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({}),
      });
      expect([400, 422]).toContain(res.status);
    });

    it("rejects invalid UUID for providerId", async () => {
      const res = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId: "not-a-uuid",
          serviceTypeId,
          startTime: "2026-03-23T10:00:00Z",
          customerName: "Test",
          customerEmail: "test@test.com",
          paymentMethod: "cash",
        }),
      });
      expect([400, 422]).toContain(res.status);
    });

    it("rejects invalid datetime format", async () => {
      const res = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "not-a-datetime",
          customerName: "Test",
          customerEmail: "test@test.com",
          paymentMethod: "cash",
        }),
      });
      expect([400, 422]).toContain(res.status);
    });

    it("rejects invalid email format", async () => {
      const res = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "2026-03-23T10:00:00Z",
          customerName: "Test",
          customerEmail: "not-an-email",
          paymentMethod: "cash",
        }),
      });
      expect([400, 422]).toContain(res.status);
    });

    it("rejects invalid payment method", async () => {
      const res = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "2026-03-23T10:00:00Z",
          customerName: "Test",
          customerEmail: "test@test.com",
          paymentMethod: "bitcoin",
        }),
      });
      expect([400, 422]).toContain(res.status);
    });

    it("rejects invalid day of week in availability", async () => {
      const res = await app.request(
        `http://localhost/api/appointments/availability/${providerId}/weekly`,
        {
          method: "PUT",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({
            schedules: [{ dayOfWeek: 7, startTime: "09:00", endTime: "17:00" }],
          }),
        },
      );
      expect([400, 422]).toContain(res.status);
    });

    it("rejects invalid time format in breaks", async () => {
      const res = await app.request(
        `http://localhost/api/appointments/availability/${providerId}/breaks`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ startTime: "9am", endTime: "10am" }),
        },
      );
      expect([400, 422]).toContain(res.status);
    });

    it("rejects invalid date format in overrides", async () => {
      const res = await app.request(
        `http://localhost/api/appointments/availability/${providerId}/overrides`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ date: "March 25", isAvailable: false }),
        },
      );
      expect([400, 422]).toContain(res.status);
    });

    it("rejects slug with less than 1 char for service type", async () => {
      const res = await app.request("http://localhost/api/appointments/services", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ name: "X", slug: "", durationMinutes: 30, priceCents: 0 }),
      });
      expect([400, 422]).toContain(res.status);
    });
  });

  // ─── State Machine Violations ──────────────────────────────────────────────

  describe("state machine violations", () => {
    it("cannot confirm a cancelled booking", async () => {
      const createRes = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "2026-03-24T09:00:00Z",
          customerName: "State Test",
          customerEmail: "state@test.com",
          paymentMethod: "cash",
        }),
      });
      const booking = (await createRes.json()).data.booking;

      // Cancel
      await app.request(
        `http://localhost/api/appointments/bookings/${booking.id}/cancel`,
        {
          method: "POST",
          headers: jsonHeaders(customerActor),
          body: JSON.stringify({ reason: "test" }),
        },
      );

      // Try to confirm cancelled booking
      const confirmRes = await app.request(
        `http://localhost/api/appointments/bookings/${booking.id}/confirm`,
        { method: "POST", headers: jsonHeaders(testAdminActor) },
      );
      const data = await confirmRes.json();
      expect(data.error).toBeDefined();
    });

    it("cannot reschedule a completed booking", async () => {
      const createRes = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "2026-03-24T10:00:00Z",
          customerName: "Complete Test",
          customerEmail: "complete@test.com",
          paymentMethod: "cash",
        }),
      });
      const booking = (await createRes.json()).data.booking;

      // Confirm then complete
      await app.request(
        `http://localhost/api/appointments/bookings/${booking.id}/confirm`,
        { method: "POST", headers: jsonHeaders(testAdminActor) },
      );
      await app.request(
        `http://localhost/api/appointments/bookings/${booking.id}/complete`,
        { method: "POST", headers: jsonHeaders(testAdminActor) },
      );

      // Try to reschedule completed booking
      const rescheduleRes = await app.request(
        `http://localhost/api/appointments/bookings/${booking.id}/reschedule`,
        {
          method: "POST",
          headers: jsonHeaders(customerActor),
          body: JSON.stringify({ newStartTime: "2026-03-25T09:00:00Z" }),
        },
      );
      const data = await rescheduleRes.json();
      expect(data.error).toBeDefined();
    });

    it("cannot mark no-show on provisional booking", async () => {
      const createRes = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId,
          startTime: "2026-03-24T11:00:00Z",
          customerName: "NoShow Test",
          customerEmail: "noshow@test.com",
          paymentMethod: "cash",
        }),
      });
      const booking = (await createRes.json()).data.booking;

      // Try no-show without confirming first
      const noShowRes = await app.request(
        `http://localhost/api/appointments/bookings/${booking.id}/no-show`,
        { method: "POST", headers: jsonHeaders(testAdminActor) },
      );
      const data = await noShowRes.json();
      expect(data.error).toBeDefined();
    });
  });

  // ─── Booking for Non-Existent Entities ──────────────────────────────────────

  describe("booking for non-existent entities", () => {
    it("rejects booking with non-existent provider", async () => {
      const res = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId: "00000000-0000-0000-0000-000000000000",
          serviceTypeId,
          startTime: "2026-03-23T10:00:00Z",
          customerName: "Test",
          customerEmail: "test@test.com",
          paymentMethod: "cash",
        }),
      });
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it("rejects booking with non-existent service type", async () => {
      const res = await app.request("http://localhost/api/appointments/bookings", {
        method: "POST",
        headers: jsonHeaders(customerActor),
        body: JSON.stringify({
          providerId,
          serviceTypeId: "00000000-0000-0000-0000-000000000000",
          startTime: "2026-03-23T10:00:00Z",
          customerName: "Test",
          customerEmail: "test@test.com",
          paymentMethod: "cash",
        }),
      });
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it("returns 404-like error for non-existent booking", async () => {
      const res = await app.request(
        "http://localhost/api/appointments/bookings/00000000-0000-0000-0000-000000000000",
        { headers: jsonHeaders(customerActor) },
      );
      const data = await res.json();
      expect(data.error).toBeDefined();
    });
  });

  // ─── Slot Query Edge Cases ──────────────────────────────────────────────────

  describe("slot query edge cases", () => {
    it("returns empty slots for a weekend day (no availability set)", async () => {
      const svcRes = await app.request("http://localhost/api/appointments/services", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ name: "Weekend Test", slug: "weekend-test", durationMinutes: 30, priceCents: 1000 }),
      });
      const svcId = (await svcRes.json()).data.id;

      await app.request(`http://localhost/api/appointments/providers/${providerId}/services`, {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ serviceTypeId: svcId }),
      });

      // 2026-03-22 is a Sunday — no weekly availability set for Sunday
      const res = await app.request(
        `http://localhost/api/appointments/availability/${providerId}/slots?date=2026-03-22&serviceTypeId=${svcId}`,
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data).toHaveLength(0);
    });

    it("returns slots for a day-off override as empty", async () => {
      // Add a day-off override for Monday
      await app.request(
        `http://localhost/api/appointments/availability/${providerId}/overrides`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ date: "2026-04-06", isAvailable: false, reason: "Holiday" }),
        },
      );

      const res = await app.request(
        `http://localhost/api/appointments/availability/${providerId}/slots?date=2026-04-06&serviceTypeId=${serviceTypeId}`,
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data).toHaveLength(0);
    });
  });
});
