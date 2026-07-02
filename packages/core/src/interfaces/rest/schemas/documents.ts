import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

const IdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

export const EmailInvoiceBodySchema = z.object({
  to: z.email().openapi({ example: "customer@example.com" }),
}).openapi("EmailInvoiceRequest");

const DataResponse = z.object({ data: z.any() }).openapi("DocumentActionResponse");

export const invoicePdfRoute = createRoute({
  method: "get",
  path: "/{id}/invoice.pdf",
  tags: ["Documents"],
  summary: "Render the order's invoice as PDF (issues a fiscal invoice number on first render)",
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/pdf": { schema: z.any().openapi({ type: "string", format: "binary" }) } },
      description: "The rendered PDF invoice.",
    },
    ...errorResponses,
  },
});

export const invoiceHtmlRoute = createRoute({
  method: "get",
  path: "/{id}/invoice.html",
  tags: ["Documents"],
  summary: "Render the order's invoice as HTML",
  request: { params: IdParam },
  responses: {
    200: {
      content: { "text/html": { schema: z.string() } },
      description: "The rendered HTML invoice.",
    },
    ...errorResponses,
  },
});

export const receiptHtmlRoute = createRoute({
  method: "get",
  path: "/{id}/receipt.html",
  tags: ["Documents"],
  summary: "Render the order's receipt as HTML",
  request: { params: IdParam },
  responses: {
    200: {
      content: { "text/html": { schema: z.string() } },
      description: "The rendered HTML receipt.",
    },
    ...errorResponses,
  },
});

export const emailInvoiceRoute = createRoute({
  method: "post",
  path: "/{id}/invoice/email",
  tags: ["Documents"],
  summary: "Email the order's invoice via the configured email adapter",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: EmailInvoiceBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Invoice emailed." },
    ...errorResponses,
  },
});
