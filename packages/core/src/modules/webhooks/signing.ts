import { createHmac } from "node:crypto";

export function signWebhookPayload(secret: string, payload: unknown): string {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHmac("sha256", secret).update(body).digest("hex");
}
