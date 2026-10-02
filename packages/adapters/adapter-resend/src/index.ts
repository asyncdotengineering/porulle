import { renderEmail } from "@porulle/core";
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

  return {
    async send(input) {
      const data = input.data ?? {};
      const rendered = renderEmail(input.template, data, {
        ...(options.subjects ? { subjects: options.subjects } : {}),
        ...(options.templates ? { templates: options.templates } : {}),
      });

      // If a Resend template ID is configured, use server-side template rendering
      const resendTemplateId = options.resendTemplateIds?.[input.template];
      if (resendTemplateId) {
        // Resend's template field is not yet typed in the SDK (upstream type gap).
        // Cast required because CreateEmailOptions doesn't include `template`.
        const { error: templateError } = await resend.emails.send({
          from: options.from,
          to: [input.to],
          subject: rendered.subject,
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
      const { error } = await resend.emails.send({
        from: options.from,
        to: [input.to],
        subject: rendered.subject,
        html: rendered.html,
      });

      if (error) {
        throw new Error(`Resend email failed: ${error.message}`);
      }
    },
  };
}
