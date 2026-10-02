import { describe, expect, it, vi } from "vitest";
import { Ok } from "@porulle/core";
import { ReceiptService } from "../src/services/receipt-service.js";
import type { Db } from "../src/types.js";

describe("ReceiptService HTML", () => {
  it("escapes line item titles and formats JPY amounts without cent division", async () => {
    let capturedHtml = "";
    const service = new ReceiptService({} as Db, {
      email: {
        send: async (opts: { html: string }) => {
          capturedHtml = opts.html;
        },
      },
    });

    vi.spyOn(service, "getReceipt").mockResolvedValue(
      Ok({
        receiptNumber: "R2-0001",
        transactionId: "txn-1",
        terminalCode: "R2",
        operatorName: "op-1",
        timestamp: new Date("2026-01-15T12:00:00.000Z"),
        lineItems: [
          {
            title: "<script>alert(1)</script>",
            quantity: 1,
            unitPrice: 150,
            totalPrice: 150,
          },
        ],
        subtotal: 150,
        discountTotal: 0,
        taxTotal: 0,
        total: 150,
        payments: [{ method: "cash", amount: 150, changeGiven: 0, reference: null }],
        changeDue: 0,
        customerId: null,
        currency: "JPY",
      }),
    );

    const result = await service.emailReceipt("org-1", "txn-1", "buyer@example.com");
    expect(result.ok).toBe(true);
    expect(capturedHtml).not.toContain("<script>");
    expect(capturedHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(capturedHtml).toContain("150");
    expect(capturedHtml).not.toContain("1.50");
  });
});
