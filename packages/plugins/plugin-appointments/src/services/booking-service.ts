import { eq, and, gte, lte } from "@porulle/core/drizzle";
import { bookings, bookingPayments, serviceTypes, providers } from "../schema.js";
import { SlotService } from "./slot-service.js";
import type { Db, BookingStatus } from "../types.js";
import type { JobsAdapter } from "@porulle/core";

interface BookingInput {
  providerId: string;
  serviceTypeId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | undefined;
  startTime: Date;
  paymentMethod: "card" | "cash" | "invoice";
  notes?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface PaymentAdapterLike {
  createPaymentIntent(params: {
    amount: number;
    currency: string;
    orderId: string;
    customerId?: string | undefined;
    metadata?: Record<string, string> | undefined;
  }): Promise<{ ok: true; value: { id: string; clientSecret?: string | null } } | { ok: false; error: { message: string } }>;
  refundPayment(paymentId: string, amount: number, reason?: string): Promise<{ ok: boolean }>;
}

export class BookingService {
  private transitions: Record<string, string[]> = {
    provisional: ["confirmed", "cancelled"],
    confirmed: ["completed", "cancelled", "no_show"],
    completed: [],
    cancelled: [],
    no_show: [],
  };

  constructor(
    private db: Db,
    private slotService: SlotService,
    private paymentAdapter?: PaymentAdapterLike,
    private jobs?: JobsAdapter,
  ) {}

  private async providerOrganizationId(providerId: string): Promise<string> {
    const [row] = await this.db
      .select({ organizationId: providers.organizationId })
      .from(providers)
      .where(eq(providers.id, providerId));
    if (!row) {
      throw new Error(`Appointment provider not found: ${providerId}`);
    }
    return row.organizationId;
  }

  async create(input: BookingInput, txDb?: Db): Promise<{
    ok: true;
    booking: typeof bookings.$inferSelect;
    paymentIntent?: { id: string; clientSecret?: string | null } | undefined;
  } | { ok: false; error: string; code: string }> {
    // Validate service type exists (outside transaction -- read-only, no lock needed)
    const [service] = await this.db.select().from(serviceTypes).where(eq(serviceTypes.id, input.serviceTypeId));
    if (!service) return { ok: false, error: "Service type not found", code: "NOT_FOUND" };

    // Validate provider exists
    const [provider] = await this.db.select().from(providers).where(eq(providers.id, input.providerId));
    if (!provider) return { ok: false, error: "Provider not found", code: "NOT_FOUND" };

    const durationMinutes = service.durationMinutes;
    const endTime = new Date(input.startTime.getTime() + durationMinutes * 60_000);
    const priceCents = service.priceCents;

    // Create payment intent if card payment (outside transaction -- external API call)
    let paymentIntentId: string | undefined;
    let paymentIntent: { id: string; clientSecret?: string | null } | undefined;

    if (input.paymentMethod === "card" && this.paymentAdapter) {
      const result = await this.paymentAdapter.createPaymentIntent({
        amount: priceCents,
        currency: service.currency,
        orderId: `appointment-${Date.now()}`,
        customerId: input.customerId,
        metadata: { serviceTypeId: input.serviceTypeId, providerId: input.providerId },
      });

      if (!result.ok) {
        return { ok: false, error: "Payment creation failed", code: "PAYMENT_ERROR" };
      }

      paymentIntentId = result.value.id;
      paymentIntent = result.value;
    }

    // Conflict check + insert MUST be in a transaction for SELECT FOR UPDATE to hold the lock.
    // Without a transaction, the row lock is released immediately after the SELECT.
    const db = txDb ?? this.db;

    const bookingOrError = await db.transaction(async (tx) => {
      // Check for conflicts (SELECT FOR UPDATE holds lock until COMMIT)
      const conflicting = await tx
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.providerId, input.providerId),
            lte(bookings.startTime, endTime),
            gte(bookings.endTime, input.startTime),
          ),
        )
        .for("update");

      const activeConflicts = conflicting.filter(
        (b) => b.status !== "cancelled",
      );

      if (activeConflicts.length > 0) {
        return { ok: false as const, error: "Time slot is already booked", code: "CONFLICT" };
      }

      const [booking] = await tx.insert(bookings).values({
        providerId: input.providerId,
        serviceTypeId: input.serviceTypeId,
        customerId: input.customerId,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        startTime: input.startTime,
        endTime,
        status: "provisional",
        paymentMethod: input.paymentMethod,
        notes: input.notes,
        metadata: input.metadata ?? {},
      }).returning();

      // Create payment record if card payment
      if (paymentIntentId && booking) {
        await tx.insert(bookingPayments).values({
          bookingId: booking.id,
          amountCents: priceCents,
          currency: service.currency,
          status: "pending",
          paymentIntentId,
        });
      }

      return { ok: true as const, booking: booking! };
    });

    if (!bookingOrError.ok) {
      return bookingOrError;
    }

    // Enqueue notification jobs (fire-and-forget, must not block the response)
    if (this.jobs) {
      const bk = bookingOrError.booking;
      const organizationId = provider.organizationId;
      const startMs = bk.startTime.getTime();

      // 24h reminder
      const r24 = startMs - 24 * 60 * 60_000 - Date.now();
      if (r24 > 0) {
        this.jobs.enqueue("appointment:reminder", { bookingId: bk.id, customerEmail: bk.customerEmail, reminderType: "24h" }, { organizationId, delayMs: r24 }).catch(() => {});
      }
      // 1h reminder
      const r1 = startMs - 60 * 60_000 - Date.now();
      if (r1 > 0) {
        this.jobs.enqueue("appointment:reminder", { bookingId: bk.id, customerEmail: bk.customerEmail, reminderType: "1h" }, { organizationId, delayMs: r1 }).catch(() => {});
      }
      // Auto-cancel unpaid provisionals
      if (bk.paymentMethod !== "card") {
        const ac = startMs - 24 * 60 * 60_000 - Date.now();
        if (ac > 0) {
          this.jobs.enqueue("appointment:auto-cancel", { bookingId: bk.id, reason: "Unpaid provisional auto-cancelled" }, { organizationId, delayMs: ac }).catch(() => {});
        }
      }
    }

    const result: {
      ok: true;
      booking: typeof bookings.$inferSelect;
      paymentIntent?: { id: string; clientSecret?: string | null } | undefined;
    } = { ok: true, booking: bookingOrError.booking };
    if (paymentIntent) result.paymentIntent = paymentIntent;
    return result;
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    return row ?? null;
  }

  async listByCustomer(customerId: string) {
    return this.db.select().from(bookings)
      .where(eq(bookings.customerId, customerId))
      .orderBy(bookings.startTime);
  }

  async listByProvider(providerId: string, from?: Date, to?: Date) {
    const conditions = [eq(bookings.providerId, providerId)];
    if (from) conditions.push(gte(bookings.startTime, from));
    if (to) conditions.push(lte(bookings.startTime, to));

    return this.db.select().from(bookings)
      .where(and(...conditions))
      .orderBy(bookings.startTime);
  }

  async changeStatus(
    id: string,
    newStatus: BookingStatus,
    reason?: string,
  ): Promise<{ ok: true; booking: typeof bookings.$inferSelect } | { ok: false; error: string }> {
    const booking = await this.getById(id);
    if (!booking) return { ok: false, error: "Booking not found" };

    const allowed = this.transitions[booking.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return { ok: false, error: `Cannot transition from ${booking.status} to ${newStatus}` };
    }

    const updates: Record<string, unknown> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    if (newStatus === "cancelled" && reason) {
      updates.cancellationReason = reason;
    }

    const [updated] = await this.db.update(bookings)
      .set(updates)
      .where(eq(bookings.id, id))
      .returning();

    // Enqueue status-specific notifications
    if (this.jobs && updated) {
      const organizationId = await this.providerOrganizationId(updated.providerId);
      if (newStatus === "confirmed") {
        this.jobs.enqueue("appointment:confirmation-notice", { bookingId: id, customerEmail: updated.customerEmail, providerId: updated.providerId }, { organizationId }).catch(() => {});
      } else if (newStatus === "no_show") {
        this.jobs.enqueue("appointment:no-show-notice", { bookingId: id, customerEmail: updated.customerEmail }, { organizationId }).catch(() => {});
      }
    }

    return { ok: true, booking: updated! };
  }

  async cancel(
    id: string,
    reason?: string,
  ): Promise<{ ok: true; booking: typeof bookings.$inferSelect; refunded: boolean } | { ok: false; error: string }> {
    const result = await this.changeStatus(id, "cancelled", reason);
    if (!result.ok) return result;

    let refunded = false;

    // Check for payment record and refund if paid
    const [payment] = await this.db.select().from(bookingPayments)
      .where(eq(bookingPayments.bookingId, id));

    if (payment?.paymentIntentId && this.paymentAdapter) {
      await this.paymentAdapter.refundPayment(
        payment.paymentIntentId,
        payment.amountCents,
        reason ?? "Booking cancelled",
      );
      await this.db.update(bookingPayments)
        .set({ status: "refunded", refundedAt: new Date() })
        .where(eq(bookingPayments.id, payment.id));
      refunded = true;
    }

    // Enqueue cancellation notice
    if (this.jobs) {
      const organizationId = await this.providerOrganizationId(result.booking.providerId);
      this.jobs.enqueue("appointment:cancellation-notice", { bookingId: id, customerEmail: result.booking.customerEmail }, { organizationId }).catch(() => {});
    }

    return { ok: true, booking: result.booking, refunded };
  }

  async reschedule(
    bookingId: string,
    newStartTime: Date,
    txDb?: Db,
  ): Promise<{ ok: true; oldBooking: typeof bookings.$inferSelect; newBooking: typeof bookings.$inferSelect } | { ok: false; error: string }> {
    const db = txDb ?? this.db;

    const existing = await this.getById(bookingId);
    if (!existing) return { ok: false, error: "Booking not found" };
    if (existing.status === "cancelled" || existing.status === "completed" || existing.status === "no_show") {
      return { ok: false, error: `Cannot reschedule a ${existing.status} booking` };
    }

    // Cancel old booking
    const cancelResult = await this.changeStatus(bookingId, "cancelled", "Rescheduled");
    if (!cancelResult.ok) return cancelResult;

    // Create new booking
    const createResult = await this.create({
      providerId: existing.providerId,
      serviceTypeId: existing.serviceTypeId,
      customerId: existing.customerId,
      customerName: existing.customerName,
      customerEmail: existing.customerEmail,
      customerPhone: existing.customerPhone ?? undefined,
      startTime: newStartTime,
      paymentMethod: existing.paymentMethod as "card" | "cash" | "invoice",
      notes: existing.notes ?? undefined,
      metadata: { ...(existing.metadata as Record<string, unknown> ?? {}), rescheduledFromId: bookingId },
    }, db);

    if (!createResult.ok) {
      return { ok: false, error: createResult.error };
    }

    // Update the new booking to reference the old one
    await db.update(bookings)
      .set({ rescheduledFromId: bookingId })
      .where(eq(bookings.id, createResult.booking.id));

    return { ok: true, oldBooking: cancelResult.booking, newBooking: createResult.booking };
  }

  async markNoShow(id: string): Promise<{ ok: true; booking: typeof bookings.$inferSelect } | { ok: false; error: string }> {
    return this.changeStatus(id, "no_show");
  }

  async complete(id: string): Promise<{ ok: true; booking: typeof bookings.$inferSelect } | { ok: false; error: string }> {
    return this.changeStatus(id, "confirmed").then((r) => {
      if (!r.ok) {
        // Try direct to completed if already confirmed
        return this.changeStatus(id, "completed");
      }
      return this.changeStatus(id, "completed");
    });
  }
}
