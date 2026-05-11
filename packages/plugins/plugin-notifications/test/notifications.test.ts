import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, testNoPermActor } from "@porulle/core/testing";
import { notificationsPlugin, consoleSMSAdapter, consolePushAdapter, consolePrintAdapter } from "../src/index.js";
import { notifAdminActor, notifWriterActor, notifReaderActor } from "./test-utils.js";

const CUSTOMER_ID = "b482a588-1234-4abc-9def-0e1f2a3b4c5d";

describe("Notifications Plugin", () => {
  let app: PluginTestApp["app"];
  let smsTemplateId: string;
  let pushTemplateId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(notificationsPlugin({
      sms: consoleSMSAdapter(),
      push: consolePushAdapter(),
      print: consolePrintAdapter(),
    }));
    app = result.app;
  }, 30_000);

  // ── Template CRUD ────────────────────────────────────────────────

  it("creates SMS template for order.completed -> 201", async () => {
    const res = await app.request("http://localhost/api/notifications/templates", {
      method: "POST", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({
        event: "order.completed", channel: "sms",
        bodyTemplate: "Your order {{orderId}} is complete! Total: {{total}}",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    smsTemplateId = body.data.id;
    expect(body.data.event).toBe("order.completed");
    expect(body.data.channel).toBe("sms");
  });

  it("creates push template for kds.ready -> 201", async () => {
    const res = await app.request("http://localhost/api/notifications/templates", {
      method: "POST", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({
        event: "kds.ready", channel: "push",
        subject: "Order Ready",
        bodyTemplate: "Order {{orderId}} is ready for pickup!",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    pushTemplateId = body.data.id;
    expect(body.data.event).toBe("kds.ready");
    expect(body.data.channel).toBe("push");
  });

  it("rejects duplicate template -> error", async () => {
    const res = await app.request("http://localhost/api/notifications/templates", {
      method: "POST", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({
        event: "order.completed", channel: "sms",
        bodyTemplate: "Duplicate",
      }),
    });
    // The service returns an Err which the route handler throws as an Error → 500
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("gets template by ID -> 200", async () => {
    const res = await app.request(`http://localhost/api/notifications/templates/${smsTemplateId}`, {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(smsTemplateId);
    expect(body.data.event).toBe("order.completed");
  });

  it("lists templates filtered by event -> returns correct", async () => {
    const res = await app.request("http://localhost/api/notifications/templates?event=order.completed", {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].event).toBe("order.completed");
  });

  it("lists templates filtered by channel -> returns correct", async () => {
    const res = await app.request("http://localhost/api/notifications/templates?channel=push", {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].channel).toBe("push");
  });

  it("updates template subject -> 200", async () => {
    const res = await app.request(`http://localhost/api/notifications/templates/${smsTemplateId}`, {
      method: "PATCH", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({ subject: "Order Update" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.subject).toBe("Order Update");
  });

  // ── Template Rendering ─────────────────────────────────────────────

  it("send notification renders template variables -> log entry created", async () => {
    const res = await app.request("http://localhost/api/notifications/send", {
      method: "POST", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({
        event: "order.completed", channel: "sms",
        recipient: "+94771234567",
        data: { orderId: "ORD-001", total: "$99.00" },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("sent");
    expect(body.data.channel).toBe("sms");
    expect(body.data.event).toBe("order.completed");
  });

  // ── Customer Preferences ───────────────────────────────────────────

  it("sets customer preference: SMS enabled -> 201", async () => {
    const res = await app.request("http://localhost/api/notifications/preferences", {
      method: "POST", headers: jsonHeaders(notifWriterActor),
      body: JSON.stringify({
        customerId: CUSTOMER_ID, channel: "sms",
        isEnabled: true, destination: "+94771234567",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.channel).toBe("sms");
    expect(body.data.isEnabled).toBe(true);
    expect(body.data.destination).toBe("+94771234567");
  });

  it("sets customer preference: email disabled -> 201", async () => {
    const res = await app.request("http://localhost/api/notifications/preferences", {
      method: "POST", headers: jsonHeaders(notifWriterActor),
      body: JSON.stringify({
        customerId: CUSTOMER_ID, channel: "email",
        isEnabled: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.channel).toBe("email");
    expect(body.data.isEnabled).toBe(false);
  });

  it("gets customer preferences -> returns list", async () => {
    const res = await app.request(`http://localhost/api/notifications/preferences/${CUSTOMER_ID}`, {
      headers: jsonHeaders(notifReaderActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("send with disabled channel for customer -> blocked", async () => {
    // Create email template first
    await app.request("http://localhost/api/notifications/templates", {
      method: "POST", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({
        event: "order.shipped", channel: "email",
        subject: "Shipped!", bodyTemplate: "Your order {{orderId}} has shipped.",
      }),
    });

    // Try to send email to this customer — email is disabled
    const res = await app.request("http://localhost/api/notifications/send", {
      method: "POST", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({
        event: "order.shipped", channel: "email",
        recipient: "test@example.com",
        customerId: CUSTOMER_ID,
        data: { orderId: "ORD-002" },
      }),
    });
    // Should be blocked because customer disabled email
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ── Notification Log ───────────────────────────────────────────────

  it("queries log filtered by channel -> returns correct", async () => {
    const res = await app.request("http://localhost/api/notifications/log?channel=sms", {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((e: Record<string, unknown>) => e.channel === "sms")).toBe(true);
  });

  it("queries log filtered by event -> returns correct", async () => {
    const res = await app.request("http://localhost/api/notifications/log?event=order.completed", {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((e: Record<string, unknown>) => e.event === "order.completed")).toBe(true);
  });

  // ── Print Job Lifecycle ────────────────────────────────────────────

  let printJobId: string;

  it("submits print job -> 201", async () => {
    const res = await app.request("http://localhost/api/notifications/print", {
      method: "POST", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({
        type: "receipt", printerId: "printer-001",
        content: { items: [{ name: "Latte", qty: 2, price: 5.50 }], total: 11.00 },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    printJobId = body.data.id;
    expect(body.data.status).toBe("queued");
    expect(body.data.type).toBe("receipt");
    expect(body.data.printerId).toBe("printer-001");
  });

  it("gets print job by ID -> 200", async () => {
    const res = await app.request(`http://localhost/api/notifications/print/${printJobId}`, {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(printJobId);
  });

  it("lists print jobs -> includes submitted job", async () => {
    const res = await app.request("http://localhost/api/notifications/print", {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("updates print job status: queued -> printing -> 200", async () => {
    const res = await app.request(`http://localhost/api/notifications/print/${printJobId}/status`, {
      method: "PATCH", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({ status: "printing" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("printing");
  });

  it("updates print job status: printing -> printed -> 200", async () => {
    const res = await app.request(`http://localhost/api/notifications/print/${printJobId}/status`, {
      method: "PATCH", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({ status: "printed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("printed");
  });

  it("rejects invalid print job status transition -> error", async () => {
    const res = await app.request(`http://localhost/api/notifications/print/${printJobId}/status`, {
      method: "PATCH", headers: jsonHeaders(notifAdminActor),
      body: JSON.stringify({ status: "queued" }),
    });
    // printed -> queued is not a valid transition
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ── Organization Scoping ───────────────────────────────────────────

  it("org isolation: different org sees 0 templates", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff",
      permissions: ["notifications:admin"],
    };
    const res = await app.request("http://localhost/api/notifications/templates", {
      headers: jsonHeaders(otherOrg),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });

  it("org isolation: different org sees 0 print jobs", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff",
      permissions: ["notifications:admin"],
    };
    const res = await app.request("http://localhost/api/notifications/print", {
      headers: jsonHeaders(otherOrg),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });

  // ── Permission Check ───────────────────────────────────────────────

  it("no permission -> 403", async () => {
    const res = await app.request("http://localhost/api/notifications/templates", {
      method: "POST", headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({
        event: "test.event", channel: "email",
        bodyTemplate: "Test",
      }),
    });
    expect(res.status).toBe(403);
  });

  // ── Soft Delete ────────────────────────────────────────────────────

  it("soft-deletes template (sets isActive=false) -> 200", async () => {
    const res = await app.request(`http://localhost/api/notifications/templates/${pushTemplateId}`, {
      method: "DELETE", headers: jsonHeaders(notifAdminActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isActive).toBe(false);

    // Verify the template still exists but is inactive
    const getRes = await app.request(`http://localhost/api/notifications/templates/${pushTemplateId}`, {
      headers: jsonHeaders(notifAdminActor),
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.isActive).toBe(false);
  });
});
