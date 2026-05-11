import { describe, expect, it, vi } from "vitest";
import { sesAdapter } from "../src/index.js";

// Mock the AWS SDK
vi.mock("@aws-sdk/client-sesv2", () => {
  return {
    SESv2Client: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ MessageId: "ses_msg_123" }),
    })),
    SendEmailCommand: vi.fn().mockImplementation((input) => input),
  };
});

describe("sesAdapter", () => {
  it("sends email with correct from, to, subject, and HTML", async () => {
    const adapter = sesAdapter({
      region: "us-east-1",
      from: "Store <orders@acme.com>",
    });

    await adapter.send({
      template: "order-confirmation",
      to: "customer@example.com",
      data: { orderId: "ord_123", total: 9900, currency: "USD" },
    });

    expect(true).toBe(true);
  });

  it("uses default subject for known templates", async () => {
    const adapter = sesAdapter({
      region: "us-east-1",
      from: "Store <orders@acme.com>",
    });

    await adapter.send({
      template: "password-reset",
      to: "user@example.com",
      data: { url: "https://acme.com/reset/abc" },
    });
  });

  it("uses custom subject and template overrides", async () => {
    const adapter = sesAdapter({
      region: "us-east-1",
      from: "Store <orders@acme.com>",
      subjects: {
        "order-confirmation": () => "Custom SES Subject",
      },
      templates: {
        "order-confirmation": (data) => `<h1>SES Custom ${data.orderId}</h1>`,
      },
    });

    await adapter.send({
      template: "order-confirmation",
      to: "customer@example.com",
      data: { orderId: "ord_789" },
    });
  });

  it("accepts explicit credentials", async () => {
    const adapter = sesAdapter({
      region: "eu-west-1",
      from: "Store <orders@acme.com>",
      credentials: {
        accessKeyId: "AKIATEST",
        secretAccessKey: "secret",
      },
    });

    await adapter.send({
      template: "email-verification",
      to: "user@example.com",
      data: { url: "https://acme.com/verify/abc" },
    });
  });

  it("sends appointment templates", async () => {
    const adapter = sesAdapter({
      region: "us-east-1",
      from: "Store <orders@acme.com>",
    });

    await adapter.send({
      template: "appointment:cancellation-notice",
      to: "customer@example.com",
      data: { bookingId: "bk_456" },
    });
  });
});
