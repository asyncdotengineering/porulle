import { defineCommercePlugin } from "@porulle/core";
import {
  posTerminals,
  posShifts,
  posCashEvents,
  posTransactions,
  posPayments,
  posReturnItems,
  posOperatorPins,
  posPinAttempts,
} from "./schema.js";
import { TerminalService } from "./services/terminal-service.js";
import { ShiftService } from "./services/shift-service.js";
import { TransactionService } from "./services/transaction-service.js";
import { PaymentService } from "./services/payment-service.js";
import { ReturnService } from "./services/return-service.js";
import { LookupService } from "./services/lookup-service.js";
import { ReceiptService } from "./services/receipt-service.js";
import { PinService } from "./services/pin-service.js";
import { ExchangeService } from "./services/exchange-service.js";
import { buildTerminalRoutes } from "./routes/terminals.js";
import { buildShiftRoutes } from "./routes/shifts.js";
import { buildTransactionRoutes } from "./routes/transactions.js";
import { buildPaymentRoutes } from "./routes/payments.js";
import { buildReturnRoutes } from "./routes/returns.js";
import { buildLookupRoutes } from "./routes/lookup.js";
import { buildReceiptRoutes } from "./routes/receipts.js";
import { buildPinAuthRoutes } from "./routes/auth.js";
import { buildExchangeRoutes } from "./routes/exchanges.js";
import { buildPOSShippingHook, buildPOSFinalizationHook } from "./hooks/checkout-pos.js";
import type { POSPluginOptions, Db } from "./types.js";
import { DEFAULT_POS_OPTIONS } from "./types.js";

export type { POSPluginOptions } from "./types.js";
export { TerminalService } from "./services/terminal-service.js";
export { ShiftService } from "./services/shift-service.js";
export { TransactionService } from "./services/transaction-service.js";
export { PaymentService } from "./services/payment-service.js";
export { ReturnService } from "./services/return-service.js";
export { LookupService } from "./services/lookup-service.js";
export { ReceiptService } from "./services/receipt-service.js";
export { PinService, hashPin, verifyPinHash } from "./services/pin-service.js";
export { ExchangeService } from "./services/exchange-service.js";
export { createPOSPaymentAdapter } from "./payment-adapter.js";

/**
 * POS Plugin — Tier 0 Core Primitives
 *
 * Provides:
 * - Terminal management (register, tablet, mobile, kiosk)
 * - Shift management (open/close with cash tracking, Z-report)
 * - Transaction lifecycle (create, hold/recall, void, complete)
 * - Split payment support (cash, card, gift card, store credit)
 * - Returns with original order linkage
 * - Barcode/SKU lookup via indexed queries
 * - Receipt data assembly + email
 * - POS payment adapter for checkout pipeline
 * - Checkout hooks (zero shipping, transaction finalization)
 */
export function posPlugin(userOptions: POSPluginOptions = {}) {
  const options: Required<POSPluginOptions> = {
    ...DEFAULT_POS_OPTIONS,
    ...userOptions,
  };

  // Shared DB reference for hooks (populated in routes())
  const dbRef: { current: Db | null } = { current: null };

  return defineCommercePlugin({
    id: "pos",
    version: "1.0.0",

    permissions: [
      {
        scope: "pos:admin",
        description: "Register terminals, view all shifts, Z-reports, configure POS settings.",
      },
      {
        scope: "pos:manage",
        description: "Void transactions, apply discounts, process returns, override price.",
      },
      {
        scope: "pos:operate",
        description: "Open/close shifts, ring up sales, accept payment, hold/recall, reprint receipts.",
      },
    ],

    schema: () => ({
      posTerminals,
      posShifts,
      posCashEvents,
      posTransactions,
      posPayments,
      posReturnItems,
      posOperatorPins,
      posPinAttempts,
    }),

    // Scope used by PIN login to mint per-shift credentials (issue #51).
    apiKeyScopes: () => ({
      [options.pinAuth.apiKeyScope ?? "pos"]: {
        prefix: "pos_shift_",
        description: "Short-lived per-shift POS credentials minted by PIN login.",
        permissions: { pos: ["operate"] },
        references: "organization",
        enableMetadata: true,
        // Allow credentials as short as 15 minutes (Better Auth default
        // minimum is 1 day — too long for per-shift keys).
        keyExpiration: { minExpiresIn: 1 / 96 },
      },
    }),

    hooks: () => [
      buildPOSShippingHook(),
      buildPOSFinalizationHook(() => {
        if (!dbRef.current) throw new Error("POS plugin DB not initialized — hooks ran before routes()");
        return dbRef.current;
      }),
    ],

    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];

      // Populate the shared DB reference for hooks
      dbRef.current = db;

      const transactionFn = ctx.database.transaction;

      // Initialize services
      const terminalService = new TerminalService(db);
      const shiftService = new ShiftService(db, transactionFn);
      const transactionService = new TransactionService(db, transactionFn);
      const paymentService = new PaymentService(db, transactionFn);
      const returnService = new ReturnService(db);
      const lookupService = new LookupService(db, ctx.services);
      const receiptService = new ReceiptService(db, ctx.services);
      const pinService = new PinService(db, options.pinAuth);
      const exchangeService = new ExchangeService(
        db,
        ctx.services,
        transactionFn as <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>,
        transactionService,
        returnService,
      );

      // Cart service from core (for creating POS transaction carts)
      const cartService = ctx.services.cart as {
        create: (input: { currency?: string; metadata?: Record<string, unknown> }, actor: unknown) => Promise<{ ok: boolean; value?: { id: string } }>;
      };

      return [
        ...buildTerminalRoutes(terminalService, ctx),
        ...buildShiftRoutes(shiftService, ctx),
        ...buildTransactionRoutes(transactionService, cartService, ctx),
        ...buildPaymentRoutes(paymentService, transactionService, ctx),
        ...buildReturnRoutes(returnService, transactionService, paymentService, cartService, ctx),
        ...buildLookupRoutes(lookupService, ctx),
        ...buildReceiptRoutes(receiptService, ctx),
        ...buildPinAuthRoutes(pinService, ctx),
        ...buildExchangeRoutes(exchangeService, ctx),
      ];
    },
  });
}
