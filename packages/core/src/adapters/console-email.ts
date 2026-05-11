/**
 * Development email adapter that logs emails to the console.
 *
 * Zero dependencies. Use this during local development to see email
 * content in the terminal without configuring Resend or an SMTP server.
 *
 * @example
 * ```typescript
 * import { consoleEmailAdapter } from "@porulle/core";
 *
 * export default defineConfig({
 *   email: consoleEmailAdapter(),
 * });
 * ```
 */
export function consoleEmailAdapter(): {
  send(input: { template: string; to: string; data?: Record<string, unknown> }): Promise<void>;
} {
  return {
    async send(input) {
      const divider = "=".repeat(60);
      const lines = [
        "",
        divider,
        `  EMAIL: ${input.template}`,
        divider,
        `  To:       ${input.to}`,
        `  Template: ${input.template}`,
      ];

      if (input.data && Object.keys(input.data).length > 0) {
        lines.push(`  Data:`);
        for (const [key, value] of Object.entries(input.data)) {
          lines.push(`    ${key}: ${JSON.stringify(value)}`);
        }
      }

      lines.push(divider, "");

      console.log(lines.join("\n"));
    },
  };
}
