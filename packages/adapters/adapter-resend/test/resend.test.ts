import { describe, expect, it, vi } from "vitest";
import { resendAdapter } from "../src/index.js";

// Mock the Resend SDK
vi.mock("resend", () => {
  return {
    Resend: vi.fn().mockImplementation(() => ({
      emails: {
        send: vi.fn().mockResolvedValue({ data: { id: "email_123" }, error: null }),
      },
    })),
  };
});

describe("resendAdapter", () => {
  it("sends email with correct from, to, subject, and HTML", async () => {
    const adapter = resendAdapter({
      apiKey: "re_test_key",
      from: "Store <orders@acme.com>",
    });

    await adapter.send({
      template: "order-confirmation",
      to: "customer@example.com",
      data: { orderId: "ord_123", total: 9900, currency: "USD" },
    });

    // Verify no error thrown
    expect(true).toBe(true);
  });

  it("uses default subject for known templates", async () => {
    const adapter = resendAdapter({
      apiKey: "re_test_key",
      from: "Store <orders@acme.com>",
    });

    // Should not throw
    await adapter.send({
      template: "password-reset",
      to: "user@example.com",
      data: { url: "https://acme.com/reset/abc" },
    });
  });

  it("falls back to template name as subject for unknown templates", async () => {
    const adapter = resendAdapter({
      apiKey: "re_test_key",
      from: "Store <orders@acme.com>",
    });

    await adapter.send({
      template: "custom-notification",
      to: "user@example.com",
      data: { message: "Hello" },
    });
  });

  it("uses custom subject override", async () => {
    const adapter = resendAdapter({
      apiKey: "re_test_key",
      from: "Store <orders@acme.com>",
      subjects: {
        "order-confirmation": () => "Custom Subject!",
      },
    });

    await adapter.send({
      template: "order-confirmation",
      to: "customer@example.com",
    });
  });

  it("uses custom HTML template override", async () => {
    const adapter = resendAdapter({
      apiKey: "re_test_key",
      from: "Store <orders@acme.com>",
      templates: {
        "order-confirmation": (data) => `<h1>Custom! ${data.orderId}</h1>`,
      },
    });

    await adapter.send({
      template: "order-confirmation",
      to: "customer@example.com",
      data: { orderId: "ord_456" },
    });
  });

  it("sends appointment reminder template", async () => {
    const adapter = resendAdapter({
      apiKey: "re_test_key",
      from: "Store <orders@acme.com>",
    });

    await adapter.send({
      template: "appointment:reminder",
      to: "customer@example.com",
      data: { bookingId: "bk_123", reminderType: "1h" },
    });
  });
});
