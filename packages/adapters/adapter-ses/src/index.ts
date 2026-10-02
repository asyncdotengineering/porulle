import { renderEmail } from "@porulle/core";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface SESAdapterOptions {
  /** AWS region (e.g., "us-east-1"). */
  region: string;
  /** Default sender address (e.g., "Acme Store <orders@acme.com>"). Must be verified in SES. */
  from: string;
  /** AWS credentials. If omitted, uses the default credential chain (env vars, IAM role, etc.). */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
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
}

/**
 * Creates an email adapter backed by AWS SES v2.
 *
 * Implements the `config.email.send()` interface consumed by checkout hooks,
 * auth (password reset, email verification), and appointment plugin notifications.
 *
 * Sender address must be verified in SES. If your account is in the SES sandbox,
 * recipient addresses must also be verified.
 *
 * @example
 * ```typescript
 * import { sesAdapter } from "@porulle/adapter-ses";
 *
 * export default defineConfig({
 *   email: sesAdapter({
 *     region: "us-east-1",
 *     from: "Acme Store <orders@acme.com>",
 *   }),
 * });
 * ```
 */
export function sesAdapter(options: SESAdapterOptions): {
  send(input: { template: string; to: string; data?: Record<string, unknown> }): Promise<void>;
} {
  const client = new SESv2Client({
    region: options.region,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });

  return {
    async send(input) {
      const data = input.data ?? {};
      const rendered = renderEmail(input.template, data, {
        ...(options.subjects ? { subjects: options.subjects } : {}),
        ...(options.templates ? { templates: options.templates } : {}),
      });

      const command = new SendEmailCommand({
        FromEmailAddress: options.from,
        Destination: {
          ToAddresses: [input.to],
        },
        Content: {
          Simple: {
            Subject: { Data: rendered.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: rendered.html, Charset: "UTF-8" },
            },
          },
        },
      });

      const result = await client.send(command);
      if (!result.MessageId) {
        throw new Error("SES email failed: no MessageId returned");
      }
    },
  };
}
