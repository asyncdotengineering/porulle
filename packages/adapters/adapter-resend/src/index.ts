import { Resend } from "resend";

export interface ResendAdapterOptions {
  /** Resend API key (starts with re_). */
  apiKey: string;
  /** Default sender address (e.g., "Acme Store <orders@acme.com>"). */
  from: string;
  /**
   * Maps template names to subject line generators.
   * If a template is not in this map, the subject defaults to the template name.
   */
  subjects?: Record<string, (data: Record<string, unknown>) => string>;
  /**
   * Maps template names to HTML body generators.
   * If a template is not in this map, a minimal default is used.
   */
  templates?: Record<string, (data: Record<string, unknown>) => string>;
  /**
   * Optional Resend template IDs. When provided, the adapter uses
   * Resend's server-side template rendering instead of local HTML.
   */
  resendTemplateIds?: Record<string, string>;
}

const DEFAULT_SUBJECTS: Record<string, (data: Record<string, unknown>) => string> = {
  "order-confirmation": (d) => `Order Confirmed${d.orderId ? ` - #${String(d.orderId).slice(0, 8)}` : ""}`,
  "order-status-change": (d) => `Order Update - ${d.newStatus ?? "Status Changed"}`,
  "password-reset": () => "Reset Your Password",
  "email-verification": () => "Verify Your Email Address",
  "appointment:reminder": (d) => `Appointment Reminder${d.reminderType === "1h" ? " - Starting Soon" : ""}`,
  "appointment:confirmation-notice": () => "Appointment Confirmed",
  "appointment:cancellation-notice": () => "Appointment Cancelled",
  "appointment:no-show-notice": () => "Missed Appointment",
};

const DEFAULT_TEMPLATES: Record<string, (data: Record<string, unknown>) => string> = {
  "order-confirmation": (d) =>
    `<h2>Order Confirmed</h2><p>Thank you for your order${d.orderId ? ` <strong>#${String(d.orderId).slice(0, 8)}</strong>` : ""}.</p>${d.total ? `<p>Total: ${d.currency ?? "USD"} ${String(d.total)}</p>` : ""}`,
  "order-status-change": (d) =>
    `<h2>Order Update</h2><p>Your order${d.orderId ? ` <strong>#${String(d.orderId).slice(0, 8)}</strong>` : ""} status has been updated to <strong>${d.newStatus ?? "unknown"}</strong>.</p>`,
  "password-reset": (d) =>
    `<h2>Reset Your Password</h2><p>Click the link below to reset your password:</p><p><a href="${d.url ?? "#"}">Reset Password</a></p>`,
  "email-verification": (d) =>
    `<h2>Verify Your Email</h2><p>Click the link below to verify your email address:</p><p><a href="${d.url ?? "#"}">Verify Email</a></p>`,
  "appointment:reminder": (d) =>
    `<h2>Appointment Reminder</h2><p>This is a${d.reminderType === "1h" ? " 1-hour" : " 24-hour"} reminder for your upcoming appointment.</p><p>Booking ID: ${d.bookingId ?? "N/A"}</p>`,
  "appointment:confirmation-notice": (d) =>
    `<h2>Appointment Confirmed</h2><p>Your appointment has been confirmed.</p><p>Booking ID: ${d.bookingId ?? "N/A"}</p>`,
  "appointment:cancellation-notice": (d) =>
    `<h2>Appointment Cancelled</h2><p>Your appointment has been cancelled.</p><p>Booking ID: ${d.bookingId ?? "N/A"}</p>`,
  "appointment:no-show-notice": (d) =>
    `<h2>Missed Appointment</h2><p>You missed your appointment. Please contact us to rebook.</p><p>Booking ID: ${d.bookingId ?? "N/A"}</p>`,
};

/**
 * Creates an email adapter backed by Resend.
 *
 * Implements the `config.email.send()` interface consumed by checkout hooks,
 * auth (password reset, email verification), and appointment plugin notifications.
 *
 * @example
 * ```typescript
 * import { resendAdapter } from "@porulle/adapter-resend";
 *
 * export default defineConfig({
 *   email: resendAdapter({
 *     apiKey: process.env.RESEND_API_KEY!,
 *     from: "Acme Store <orders@acme.com>",
 *   }),
 * });
 * ```
 */
export function resendAdapter(options: ResendAdapterOptions): {
  send(input: { template: string; to: string; data?: Record<string, unknown> }): Promise<void>;
} {
  const resend = new Resend(options.apiKey);

  const subjects = { ...DEFAULT_SUBJECTS, ...options.subjects };
  const templates = { ...DEFAULT_TEMPLATES, ...options.templates };

  return {
    async send(input) {
      const data = input.data ?? {};
      const subjectFn = subjects[input.template];
      const subject = subjectFn ? subjectFn(data) : input.template;

      // If a Resend template ID is configured, use server-side template rendering
      const resendTemplateId = options.resendTemplateIds?.[input.template];
      if (resendTemplateId) {
        // Resend's template field is not yet typed in the SDK (upstream type gap).
        // Cast required because CreateEmailOptions doesn't include `template`.
        const { error: templateError } = await resend.emails.send({
          from: options.from,
          to: [input.to],
          subject,
          template: {
            id: resendTemplateId,
            variables: data as Record<string, string | number>,
          },
        } as unknown as Parameters<typeof resend.emails.send>[0]);
        if (templateError) {
          throw new Error(`Resend template email failed: ${templateError.message}`);
        }
        return;
      }

      // Otherwise, use local HTML template
      const templateFn = templates[input.template];
      const html = templateFn
        ? templateFn(data)
        : `<p>Notification: ${input.template}</p><pre>${JSON.stringify(data, null, 2)}</pre>`;

      const { error } = await resend.emails.send({
        from: options.from,
        to: [input.to],
        subject,
        html,
      });

      if (error) {
        throw new Error(`Resend email failed: ${error.message}`);
      }
    },
  };
}
