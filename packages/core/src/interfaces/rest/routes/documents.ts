import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import {
  emailInvoiceRoute,
  invoiceHtmlRoute,
  invoicePdfRoute,
  receiptHtmlRoute,
} from "../schemas/documents.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus } from "../utils.js";

/**
 * Order document rendering (issue #47). Mounted under /orders. Access
 * control rides on OrderService.getById (orders:read, or orders:read:own
 * for the order's customer), so no extra scope is needed here.
 */
export function documentRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(invoicePdfRoute, async (c) => {
    const result = await kernel.services.documents.renderInvoicePdf(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.body(result.value.pdf.slice().buffer as ArrayBuffer, 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="invoice-${result.value.invoiceNumber}.pdf"`,
    });
  });

  router.openapi(invoiceHtmlRoute, async (c) => {
    const result = await kernel.services.documents.renderInvoiceHtml(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.html(result.value.html);
  });

  router.openapi(receiptHtmlRoute, async (c) => {
    const result = await kernel.services.documents.renderReceiptHtml(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.html(result.value.html);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(emailInvoiceRoute, async (c) => {
    const result = await kernel.services.documents.emailInvoice(
      c.req.param("id"),
      c.req.valid("json").to,
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  return router;
}
