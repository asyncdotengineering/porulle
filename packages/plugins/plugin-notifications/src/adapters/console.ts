import { randomUUID } from "node:crypto";
import { Ok } from "../types.js";
import type { SMSAdapter, PushAdapter, PrintAdapter } from "./types.js";

/**
 * Console SMS adapter — logs SMS messages to stdout.
 * Use for development and testing. Replace with a real adapter (e.g. Twilio) in production.
 */
export function consoleSMSAdapter(): SMSAdapter {
  return {
    providerId: "console",
    async send(params) {
      const messageId = `sms_${randomUUID()}`;
      console.log(`[SMS:console] to=${params.to} body="${params.body}" messageId=${messageId}`);
      return Ok({ messageId });
    },
  };
}

/**
 * Console Push adapter — logs push notifications to stdout.
 * Use for development and testing. Replace with a real adapter (e.g. FCM) in production.
 */
export function consolePushAdapter(): PushAdapter {
  return {
    providerId: "console",
    async send(params) {
      const messageId = `push_${randomUUID()}`;
      console.log(
        `[Push:console] token=${params.deviceToken} title="${params.title}" body="${params.body}" messageId=${messageId}`,
      );
      return Ok({ messageId });
    },
  };
}

/**
 * Console Print adapter — logs print jobs to stdout.
 * Use for development and testing. Replace with a real adapter (e.g. ESC/POS) in production.
 */
export function consolePrintAdapter(): PrintAdapter {
  return {
    providerId: "console",
    async print(params) {
      const jobId = `print_${randomUUID()}`;
      console.log(
        `[Print:console] printer=${params.printerId} format=${params.format} jobId=${jobId}`,
      );
      return Ok({ jobId });
    },
  };
}
