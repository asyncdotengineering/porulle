import { signWebhookPayload } from "./signing.js";
import { isPrivateIp } from "./ssrf-guard.js";
import type { WebhooksRepository } from "./repository/index.js";
import type { TaskRetryConfig } from "../../kernel/jobs/types.js";

/**
 * SSRF prevention: reject webhook URLs targeting private/internal hosts.
 * Blocks RFC 1918, loopback, link-local, and common internal domains.
 */
const PRIVATE_HOST_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // RFC 1918 class A
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // RFC 1918 class B
  /^192\.168\./, // RFC 1918 class C
  /^169\.254\./, // link-local / AWS IMDS
  /^0\.0\.0\.0/, // unspecified
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
];

function validateWebhookUrl(url: string): void {
  const parsed = new URL(url);

  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("Webhook URLs must use HTTPS in production.");
  }

  const hostname = parsed.hostname;
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(`Webhook URLs cannot target private hosts: ${hostname}`);
    }
  }
}

/**
 * Resolve the webhook URL hostname via DNS and verify the resolved IP is not
 * private. This closes the DNS rebinding gap where a hostname initially
 * resolves to a public IP but later rebinds to an internal address.
 */
async function validateResolvedIp(url: string): Promise<void> {
  const { lookup } = await import("node:dns/promises");
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  // Skip DNS resolution for raw IP addresses — they are already checked
  // by validateWebhookUrl via PRIVATE_HOST_PATTERNS.
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  if (isIpLiteral) return;

  try {
    const { address } = await lookup(hostname);
    if (isPrivateIp(address)) {
      throw new Error(
        `Webhook URL hostname "${hostname}" resolved to private IP ${address}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("resolved to private")) {
      throw err;
    }
    throw new Error(`Failed to resolve webhook URL hostname "${hostname}": ${err}`);
  }
}

function deliveryBackoffDelayMs(
  jobAttempt: number,
  backoff: TaskRetryConfig["backoff"] | undefined,
): number | undefined {
  if (!backoff || jobAttempt >= Number.MAX_SAFE_INTEGER) return undefined;
  if (backoff.type === "exponential") {
    return backoff.delay * 2 ** (jobAttempt - 1);
  }
  return backoff.delay;
}

class HttpResponseWebhookError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Webhook delivery failed: HTTP ${status}`);
    this.name = "HttpResponseWebhookError";
    this.status = status;
  }
}

interface WorkerDeps {
  repository: WebhooksRepository;
  fetchImpl?: typeof fetch;
}

export class WebhookDeliveryWorker {
  private fetchImpl: typeof fetch;

  constructor(private deps: WorkerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async deliver(args: {
    endpoint: { id: string; url: string; secret: string };
    eventName: string;
    payload: unknown;
    /** Job runner attempt index (1-based). Defaults to 1 for non-job callers (e.g. inline enqueue). */
    jobAttempt?: number;
    /** Max attempts for this job; defaults to 1 when unknown so `nextRetryAt` is not set for standalone runs. */
    jobMaxAttempts?: number;
    /** Matches task retry backoff so delivery rows align with `commerce_jobs.waitUntil`. */
    retryBackoff?: TaskRetryConfig["backoff"];
  }): Promise<void> {
    const jobAttempt = args.jobAttempt ?? 1;
    const jobMaxAttempts = args.jobMaxAttempts ?? 1;

    validateWebhookUrl(args.endpoint.url);
    await validateResolvedIp(args.endpoint.url);

    const signature = signWebhookPayload(args.endpoint.secret, args.payload);

    try {
      const response = await this.fetchImpl(args.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-commerce-signature": signature,
          "x-commerce-event": args.eventName,
        },
        body: JSON.stringify(args.payload),
        signal: AbortSignal.timeout(10_000),
      });

      const delayMs = deliveryBackoffDelayMs(jobAttempt, args.retryBackoff);
      const willRetryJob = jobAttempt < jobMaxAttempts;

      await this.deps.repository.createDelivery({
        endpointId: args.endpoint.id,
        eventName: args.eventName,
        payload: args.payload,
        statusCode: response.status,
        attemptCount: jobAttempt,
        ...(response.ok ? { deliveredAt: new Date() } : { failedAt: new Date() }),
        ...(!response.ok && willRetryJob && delayMs !== undefined
          ? { nextRetryAt: new Date(Date.now() + delayMs) }
          : {}),
      });

      if (response.ok) return;

      throw new HttpResponseWebhookError(response.status);
    } catch (err) {
      if (err instanceof HttpResponseWebhookError) {
        throw err;
      }

      const delayMs = deliveryBackoffDelayMs(jobAttempt, args.retryBackoff);
      const willRetryJob = jobAttempt < jobMaxAttempts;

      await this.deps.repository.createDelivery({
        endpointId: args.endpoint.id,
        eventName: args.eventName,
        payload: args.payload,
        attemptCount: jobAttempt,
        failedAt: new Date(),
        ...(willRetryJob && delayMs !== undefined
          ? { nextRetryAt: new Date(Date.now() + delayMs) }
          : {}),
      });

      throw err;
    }
  }
}
