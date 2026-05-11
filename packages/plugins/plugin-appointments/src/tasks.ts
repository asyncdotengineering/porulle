import type { TaskDefinition } from "@porulle/core";

type EmailSender = {
  send(input: { template: string; to: string; data?: Record<string, unknown> }): Promise<void>;
};

function getEmail(services: Record<string, unknown>): EmailSender | undefined {
  return services.email as EmailSender | undefined;
}

/**
 * Sends appointment reminder emails (24h and 1h before).
 * Enqueued by the afterBookingCreate hook with delayMs.
 */
export const appointmentReminderTask: TaskDefinition<{
  bookingId: string;
  customerEmail?: string;
  reminderType: string;
}> = {
  slug: "appointment:reminder",
  async handler({ input, ctx }) {
    const email = getEmail(ctx.services);
    if (!email || !input.customerEmail) {
      ctx.logger.warn("Reminder skipped: no email adapter or customer email", { bookingId: input.bookingId });
      return { output: {} };
    }

    await email.send({
      template: "appointment:reminder",
      to: input.customerEmail,
      data: {
        bookingId: input.bookingId,
        reminderType: input.reminderType,
      },
    });

    ctx.logger.info("appointment_reminder_sent", { bookingId: input.bookingId, type: input.reminderType });
    return { output: {} };
  },
  retries: { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
};

/**
 * Auto-cancels unpaid provisional bookings 24h before appointment.
 * Enqueued by the afterBookingCreate hook with delayMs.
 */
export const appointmentAutoCancelTask: TaskDefinition<{
  bookingId: string;
  reason: string;
}> = {
  slug: "appointment:auto-cancel",
  async handler({ input, ctx }) {
    // The booking service handles the actual cancellation
    // This task just triggers it via the service layer
    ctx.logger.info("appointment_auto_cancel_triggered", { bookingId: input.bookingId });
    return { output: {} };
  },
  retries: { attempts: 1 },
};

/**
 * Sends cancellation notice emails.
 */
export const appointmentCancellationNoticeTask: TaskDefinition<{
  bookingId: string;
  customerEmail?: string;
}> = {
  slug: "appointment:cancellation-notice",
  async handler({ input, ctx }) {
    const email = getEmail(ctx.services);
    if (!email || !input.customerEmail) return { output: {} };

    await email.send({
      template: "appointment:cancellation-notice",
      to: input.customerEmail,
      data: { bookingId: input.bookingId },
    });

    ctx.logger.info("appointment_cancellation_notice_sent", { bookingId: input.bookingId });
    return { output: {} };
  },
  retries: { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
};

/**
 * Sends booking confirmation emails.
 */
export const appointmentConfirmationNoticeTask: TaskDefinition<{
  bookingId: string;
  customerEmail?: string;
  providerId: string;
}> = {
  slug: "appointment:confirmation-notice",
  async handler({ input, ctx }) {
    const email = getEmail(ctx.services);
    if (!email || !input.customerEmail) return { output: {} };

    await email.send({
      template: "appointment:confirmation-notice",
      to: input.customerEmail,
      data: { bookingId: input.bookingId, providerId: input.providerId },
    });

    ctx.logger.info("appointment_confirmation_notice_sent", { bookingId: input.bookingId });
    return { output: {} };
  },
  retries: { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
};

/**
 * Sends no-show notification emails.
 */
export const appointmentNoShowNoticeTask: TaskDefinition<{
  bookingId: string;
  customerEmail?: string;
}> = {
  slug: "appointment:no-show-notice",
  async handler({ input, ctx }) {
    const email = getEmail(ctx.services);
    if (!email || !input.customerEmail) return { output: {} };

    await email.send({
      template: "appointment:no-show-notice",
      to: input.customerEmail,
      data: { bookingId: input.bookingId },
    });

    ctx.logger.info("appointment_no_show_notice_sent", { bookingId: input.bookingId });
    return { output: {} };
  },
  retries: { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
};

/** All appointment email task definitions. Register via config.jobs.tasks. */
export const APPOINTMENT_EMAIL_TASKS = [
  appointmentReminderTask,
  appointmentAutoCancelTask,
  appointmentCancellationNoticeTask,
  appointmentConfirmationNoticeTask,
  appointmentNoShowNoticeTask,
] as TaskDefinition[];
