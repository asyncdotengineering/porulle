import type { HydratedOrder } from "../orders/service.js";
import { A4, type PdfTextOp } from "./pdf.js";

/** Branding values read from the settings module's `branding` group. */
export interface DocumentBranding {
  storeName?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  logoUrl?: string;
  address?: string;
  phone?: string;
  email?: string;
  taxId?: string;
}

export interface DocumentContext {
  order: HydratedOrder;
  branding: DocumentBranding;
  invoiceNumber: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Minor units → "1,234.50 LKR". */
export function formatAmount(minor: number, currency: string): string {
  const major = minor / 100;
  const formatted = major.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${currency}`;
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString().slice(0, 10);
}

function sellerBlockHtml(branding: DocumentBranding): string {
  const lines = [
    branding.storeName && `<strong>${escapeHtml(branding.storeName)}</strong>`,
    branding.address && escapeHtml(branding.address),
    branding.phone && escapeHtml(branding.phone),
    branding.email && escapeHtml(branding.email),
    branding.taxId && `Tax ID: ${escapeHtml(branding.taxId)}`,
  ].filter(Boolean);
  return lines.join("<br>");
}

function lineRowsHtml(order: HydratedOrder): string {
  return order.lineItems
    .map(
      (li) => `<tr>
  <td>${escapeHtml(li.title)}${li.sku ? `<br><small>${escapeHtml(li.sku)}</small>` : ""}</td>
  <td class="num">${li.quantity}</td>
  <td class="num">${escapeHtml(formatAmount(li.unitPrice, order.currency))}</td>
  <td class="num">${escapeHtml(formatAmount(li.totalPrice, order.currency))}</td>
</tr>`,
    )
    .join("\n");
}

function totalsRowsHtml(order: HydratedOrder): string {
  const rows: Array<[string, number]> = [
    ["Subtotal", order.subtotal],
    ...(order.discountTotal ? ([["Discount", -order.discountTotal]] as Array<[string, number]>) : []),
    ["Tax", order.taxTotal],
    ...(order.shippingTotal ? ([["Shipping", order.shippingTotal]] as Array<[string, number]>) : []),
  ];
  const body = rows
    .map(([label, amount]) => `<tr><td>${label}</td><td class="num">${escapeHtml(formatAmount(amount, order.currency))}</td></tr>`)
    .join("\n");
  return `${body}\n<tr class="grand"><td>Total</td><td class="num">${escapeHtml(formatAmount(order.grandTotal, order.currency))}</td></tr>`;
}

const BASE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;color:#111;margin:2rem auto;line-height:1.45}
table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #ddd}
td.num,th.num{text-align:right}
tr.grand td{font-weight:700;border-top:2px solid #111}
small{color:#666}`;

/** A4-style HTML invoice with seller branding and fiscal invoice number. */
export function invoiceHtml(ctx: DocumentContext): string {
  const { order, branding, invoiceNumber } = ctx;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice ${escapeHtml(invoiceNumber)}</title>
<style>${BASE_STYLE}
body{max-width:48rem}</style></head>
<body>
<table style="border:none"><tr>
  <td style="border:none">${sellerBlockHtml(branding)}</td>
  <td style="border:none;text-align:right">
    <h1 style="margin:0">INVOICE</h1>
    <div>Invoice #: <strong>${escapeHtml(invoiceNumber)}</strong></div>
    <div>Order #: ${escapeHtml(order.orderNumber)}</div>
    <div>Date: ${escapeHtml(formatDate(order.placedAt))}</div>
  </td>
</tr></table>
<table>
  <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
  <tbody>${lineRowsHtml(order)}</tbody>
</table>
<table style="max-width:20rem;margin-left:auto"><tbody>${totalsRowsHtml(order)}</tbody></table>
${branding.receiptFooter ? `<p><small>${escapeHtml(branding.receiptFooter)}</small></p>` : ""}
</body></html>`;
}

/** Narrow receipt-style HTML with the configured header/footer. */
export function receiptHtml(ctx: Omit<DocumentContext, "invoiceNumber"> & { invoiceNumber?: string }): string {
  const { order, branding } = ctx;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt ${escapeHtml(order.orderNumber)}</title>
<style>${BASE_STYLE}
body{max-width:22rem;font-size:.9rem}
h2,p.center{text-align:center}</style></head>
<body>
${branding.storeName ? `<h2>${escapeHtml(branding.storeName)}</h2>` : ""}
${branding.receiptHeader ? `<p class="center">${escapeHtml(branding.receiptHeader)}</p>` : ""}
${branding.taxId ? `<p class="center"><small>Tax ID: ${escapeHtml(branding.taxId)}</small></p>` : ""}
<p>Order #: ${escapeHtml(order.orderNumber)}<br>Date: ${escapeHtml(formatDate(order.placedAt))}</p>
<table>
  <tbody>${lineRowsHtml(order)}</tbody>
</table>
<table><tbody>${totalsRowsHtml(order)}</tbody></table>
${branding.receiptFooter ? `<p class="center"><small>${escapeHtml(branding.receiptFooter)}</small></p>` : ""}
</body></html>`;
}

// ── PDF layout ─────────────────────────────────────────────────────────────

const MARGIN = 50;
const LINE_HEIGHT = 16;
const COL = {
  item: MARGIN,
  qty: 380,
  unit: 440,
  total: 515,
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Lays an invoice out as pages of text ops for the minimal PDF writer.
 */
export function invoicePdfOps(ctx: DocumentContext): PdfTextOp[][] {
  const { order, branding, invoiceNumber } = ctx;
  const pages: PdfTextOp[][] = [];
  let ops: PdfTextOp[] = [];
  let y = A4.height - MARGIN;

  const write = (text: string, x: number, opts?: { size?: number | undefined; bold?: boolean | undefined }) => {
    ops.push({ x, y, size: opts?.size ?? 10, bold: opts?.bold, text });
  };
  const newline = (lines = 1) => {
    y -= LINE_HEIGHT * lines;
    if (y < MARGIN + LINE_HEIGHT) {
      pages.push(ops);
      ops = [];
      y = A4.height - MARGIN;
    }
  };

  write("INVOICE", MARGIN, { size: 20, bold: true });
  newline(2);
  write(`Invoice #: ${invoiceNumber}`, MARGIN, { bold: true });
  newline();
  write(`Order #: ${order.orderNumber}`, MARGIN);
  newline();
  write(`Date: ${formatDate(order.placedAt)}`, MARGIN);
  newline(2);

  const seller = [
    branding.storeName,
    branding.address,
    branding.phone,
    branding.email,
    branding.taxId ? `Tax ID: ${branding.taxId}` : undefined,
  ].filter((v): v is string => Boolean(v));
  for (const [i, line] of seller.entries()) {
    write(line, MARGIN, { bold: i === 0 });
    newline();
  }
  newline();

  write("Item", COL.item, { bold: true });
  write("Qty", COL.qty, { bold: true });
  write("Unit", COL.unit, { bold: true });
  write("Amount", COL.total, { bold: true });
  newline();

  for (const li of order.lineItems) {
    write(truncate(li.title, 52), COL.item);
    write(String(li.quantity), COL.qty);
    write(formatAmount(li.unitPrice, order.currency), COL.unit);
    write(formatAmount(li.totalPrice, order.currency), COL.total);
    newline();
  }
  newline();

  const totals: Array<[string, number, boolean?]> = [
    ["Subtotal", order.subtotal],
    ...(order.discountTotal ? ([["Discount", -order.discountTotal]] as Array<[string, number]>) : []),
    ["Tax", order.taxTotal],
    ...(order.shippingTotal ? ([["Shipping", order.shippingTotal]] as Array<[string, number]>) : []),
    ["Total", order.grandTotal, true],
  ];
  for (const [label, amount, bold] of totals) {
    write(label, COL.qty, { bold });
    write(formatAmount(amount, order.currency), COL.total, { bold });
    newline();
  }

  if (branding.receiptFooter) {
    newline();
    write(branding.receiptFooter, MARGIN, { size: 8 });
  }

  pages.push(ops);
  return pages;
}
