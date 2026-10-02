import { escapeHtml } from "../utils/escape-html.js";

export type EmailData = Record<string, unknown>;
export type EmailTemplateMap = Record<string, (data: EmailData) => string>;

export interface RenderEmailOptions {
  /** Subject line per template name; overrides the defaults below. Plain text, not HTML. */
  subjects?: EmailTemplateMap;
  /** HTML body per template name; overrides the defaults. Escape caller data with `escapeHtml`. */
  templates?: EmailTemplateMap;
}

const shortId = (value: unknown) => escapeHtml(String(value).slice(0, 8));

const DEFAULT_SUBJECTS: EmailTemplateMap = {
  "order-confirmation": (d) => `Order Confirmed${d.orderId ? ` - #${String(d.orderId).slice(0, 8)}` : ""}`,
  "order-status-change": (d) => `Order Update - ${String(d.newStatus ?? "Status Changed")}`,
  "password-reset": () => "Reset Your Password",
  "email-verification": () => "Verify Your Email Address",
  "appointment:reminder": (d) => `Appointment Reminder${d.reminderType === "1h" ? " - Starting Soon" : ""}`,
  "appointment:confirmation-notice": () => "Appointment Confirmed",
  "appointment:cancellation-notice": () => "Appointment Cancelled",
  "appointment:no-show-notice": () => "Missed Appointment",
};

const DEFAULT_TEMPLATES: EmailTemplateMap = {
  "order-confirmation": (d) =>
    `<h2>Order Confirmed</h2><p>Thank you for your order${d.orderId ? ` <strong>#${shortId(d.orderId)}</strong>` : ""}.</p>${d.total ? `<p>Total: ${escapeHtml(d.currency ?? "USD")} ${escapeHtml(d.total)}</p>` : ""}`,
  "order-status-change": (d) =>
    `<h2>Order Update</h2><p>Your order${d.orderId ? ` <strong>#${shortId(d.orderId)}</strong>` : ""} status has been updated to <strong>${escapeHtml(d.newStatus ?? "unknown")}</strong>.</p>`,
  "password-reset": (d) =>
    `<h2>Reset Your Password</h2><p>Click the link below to reset your password:</p><p><a href="${escapeHtml(d.url ?? "#")}">Reset Password</a></p>`,
  "email-verification": (d) =>
    `<h2>Verify Your Email</h2><p>Click the link below to verify your email address:</p><p><a href="${escapeHtml(d.url ?? "#")}">Verify Email</a></p>`,
  "appointment:reminder": (d) =>
    `<h2>Appointment Reminder</h2><p>This is a${d.reminderType === "1h" ? " 1-hour" : " 24-hour"} reminder for your upcoming appointment.</p><p>Booking ID: ${escapeHtml(d.bookingId ?? "N/A")}</p>`,
  "appointment:confirmation-notice": (d) =>
    `<h2>Appointment Confirmed</h2><p>Your appointment has been confirmed.</p><p>Booking ID: ${escapeHtml(d.bookingId ?? "N/A")}</p>`,
  "appointment:cancellation-notice": (d) =>
    `<h2>Appointment Cancelled</h2><p>Your appointment has been cancelled.</p><p>Booking ID: ${escapeHtml(d.bookingId ?? "N/A")}</p>`,
  "appointment:no-show-notice": (d) =>
    `<h2>Missed Appointment</h2><p>You missed your appointment. Please contact us to rebook.</p><p>Booking ID: ${escapeHtml(d.bookingId ?? "N/A")}</p>`,
};

/**
 * Subject and HTML body for a `config.email.send({ template, data })` call — the
 * part every transport adapter (Resend, SES, …) shares. A template with no
 * renderer falls back to a body listing its data.
 */
export function renderEmail(
  template: string,
  data: EmailData,
  options: RenderEmailOptions = {},
): { subject: string; html: string } {
  const subject = options.subjects?.[template] ?? DEFAULT_SUBJECTS[template];
  const body = options.templates?.[template] ?? DEFAULT_TEMPLATES[template];
  return {
    subject: subject ? subject(data) : template,
    html: body
      ? body(data)
      : `<p>Notification: ${escapeHtml(template)}</p><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`,
  };
}
