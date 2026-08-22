import { resolveOrgIdForCommerce } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import { hasPermission } from "../../auth/permissions.js";
import { CommerceForbiddenError, CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type { HydratedOrder, OrderService } from "../orders/service.js";
import type { SettingsService } from "../settings/service.js";
import { buildPdf } from "./pdf.js";
import {
  invoiceHtml,
  invoicePdfOps,
  receiptHtml,
  type DocumentBranding,
} from "./render.js";
import type { DocumentsRepository, OrderDocument } from "./repository/index.js";

interface DocumentsServiceDeps {
  repository: DocumentsRepository;
  // The shared kernel service container — orders/settings/email are resolved
  // at call time (they may instantiate after this module).
  services: Record<string, unknown>;
  config: CommerceConfig;
}

interface CustomerLookup {
  getById(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<{ ok: true; value: { email: string | null } } | { ok: false }>;
}

interface EmailAdapter {
  send(input: { template: string; to: string; data?: Record<string, unknown> }): Promise<void>;
}

const DEFAULT_INVOICE_PREFIX = "INV-";

/**
 * Order document rendering + fiscal numbering (issue #47).
 */
export class DocumentsService {
  private repository: DocumentsRepository;
  private services: Record<string, unknown>;
  private config: CommerceConfig;

  constructor(deps: DocumentsServiceDeps) {
    this.repository = deps.repository;
    this.services = deps.services;
    this.config = deps.config;
  }

  private get orders(): OrderService {
    return this.services.orders as OrderService;
  }

  private get settings(): SettingsService {
    return this.services.settings as SettingsService;
  }

  private async brandingFor(orgId: string, ctx?: TxContext): Promise<DocumentBranding> {
    return (await this.settings.read(orgId, "branding", ctx)) as DocumentBranding;
  }

  /**
   * Issues (or returns the previously issued) fiscal invoice number for an
   * order. Idempotent per (org, order): once handed out, the number never
   * changes. Sequence allocation is atomic; a lost creation race falls back
   * to the winner's document.
   */
  async issueInvoiceNumber(
    order: HydratedOrder,
    ctx?: TxContext,
  ): Promise<OrderDocument> {
    const orgId = order.organizationId;
    const existing = await this.repository.findDocument(orgId, order.id, "invoice", ctx);
    if (existing) return existing;

    const documentsSettings = await this.settings.read(orgId, "documents", ctx);
    const prefix =
      typeof documentsSettings.invoicePrefix === "string"
        ? documentsSettings.invoicePrefix
        : DEFAULT_INVOICE_PREFIX;

    const value = await this.repository.allocate(orgId, "invoice", ctx);
    const documentNumber = `${prefix}${String(value).padStart(6, "0")}`;
    try {
      return await this.repository.createDocument(
        { organizationId: orgId, orderId: order.id, type: "invoice", documentNumber },
        ctx,
      );
    } catch (error) {
      // Unique (org, order, type) — a concurrent request won; use its number.
      const winner = await this.repository.findDocument(orgId, order.id, "invoice", ctx);
      if (winner) return winner;
      throw error;
    }
  }

  private async loadOrder(
    orderId: string,
    actor: Actor | null,
    ctx?: TxContext,
    guestCredential?: string,
  ): Promise<Result<HydratedOrder>> {
    return this.orders.getById(orderId, actor, ctx, guestCredential);
  }

  async renderInvoiceHtml(
    orderId: string,
    actor: Actor | null,
    ctx?: TxContext,
    guestCredential?: string,
  ): Promise<Result<{ html: string; invoiceNumber: string }>> {
    const order = await this.loadOrder(orderId, actor, ctx, guestCredential);
    if (!order.ok) return order;
    const branding = await this.brandingFor(order.value.organizationId, ctx);
    const doc = await this.issueInvoiceNumber(order.value, ctx);
    return Ok({
      html: invoiceHtml({ order: order.value, branding, invoiceNumber: doc.documentNumber }),
      invoiceNumber: doc.documentNumber,
    });
  }

  async renderInvoicePdf(
    orderId: string,
    actor: Actor | null,
    ctx?: TxContext,
    guestCredential?: string,
  ): Promise<Result<{ pdf: Uint8Array; invoiceNumber: string }>> {
    const order = await this.loadOrder(orderId, actor, ctx, guestCredential);
    if (!order.ok) return order;
    const branding = await this.brandingFor(order.value.organizationId, ctx);
    const doc = await this.issueInvoiceNumber(order.value, ctx);
    const pages = invoicePdfOps({
      order: order.value,
      branding,
      invoiceNumber: doc.documentNumber,
    });
    return Ok({ pdf: buildPdf(pages), invoiceNumber: doc.documentNumber });
  }

  async renderReceiptHtml(
    orderId: string,
    actor: Actor | null,
    ctx?: TxContext,
    guestCredential?: string,
  ): Promise<Result<{ html: string }>> {
    const order = await this.loadOrder(orderId, actor, ctx, guestCredential);
    if (!order.ok) return order;
    const branding = await this.brandingFor(order.value.organizationId, ctx);
    return Ok({ html: receiptHtml({ order: order.value, branding }) });
  }

  /**
   * The address that belongs to this order: its customer profile's email.
   * A guest order has no customer profile and therefore no address of its own.
   */
  private async orderEmail(
    order: HydratedOrder,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<string | null> {
    if (!order.customerId) return null;
    const customers = this.services.customers as CustomerLookup | undefined;
    if (!customers) return null;
    const customer = await customers.getById(order.customerId, actor, ctx);
    return customer.ok ? (customer.value.email ?? null) : null;
  }

  /**
   * Emails the invoice via the configured email adapter. The adapter's
   * template contract is (template, to, data) — the rendered HTML and the
   * fiscal number ride in `data` so template-based adapters can use either.
   *
   * The destination is the order's own address, not the caller's choice. A
   * cart secret authorizes reading an order, and a caller-supplied `to` turned
   * that read into delivery: items, totals and shipping address mailed to any
   * address, with nothing left in the shopper's inbox. Only staff holding
   * org-wide `orders:read` may name a different recipient.
   */
  async emailInvoice(
    orderId: string,
    to: string,
    actor: Actor | null,
    ctx?: TxContext,
    guestCredential?: string,
  ): Promise<Result<{ sent: true; invoiceNumber: string; to: string }>> {
    const email = this.services.email as EmailAdapter | undefined;
    if (!email) {
      return Err(new CommerceValidationError("No email adapter is configured."));
    }
    const rendered = await this.renderInvoiceHtml(orderId, actor, ctx, guestCredential);
    if (!rendered.ok) return rendered;

    const order = await this.loadOrder(orderId, actor, ctx, guestCredential);
    if (!order.ok) return order;

    const ownAddress = await this.orderEmail(order.value, actor, ctx);
    const mayDirect = hasPermission(actor, "orders:read");
    const requested = to.trim();

    let destination: string;
    if (mayDirect && requested.length > 0) {
      destination = requested;
    } else if (ownAddress === null) {
      return Err(
        new CommerceValidationError(
          "This order has no email address of its own. Render the invoice instead, or send it as staff.",
        ),
      );
    } else if (requested.length > 0 && requested.toLowerCase() !== ownAddress.toLowerCase()) {
      return Err(
        new CommerceForbiddenError(
          "An invoice can only be emailed to the address on the order.",
        ),
      );
    } else {
      destination = ownAddress;
    }

    await email.send({
      template: "order-invoice",
      to: destination,
      data: {
        orgId: resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.config),
        orderId,
        orderNumber: order.value.orderNumber,
        invoiceNumber: rendered.value.invoiceNumber,
        grandTotal: order.value.grandTotal,
        currency: order.value.currency,
        html: rendered.value.html,
      },
    });
    return Ok({ sent: true, invoiceNumber: rendered.value.invoiceNumber, to: destination });
  }
}
