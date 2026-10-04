import { CHANNEL_CREDENTIALS_REJECTED, Err, Ok } from "@porulle/core";
import type { ChannelConnectorError, Result } from "@porulle/core";
import { z } from "zod";

/**
 * The one way this adapter talks to a store: the GraphQL Admin API.
 *
 * Shopify made the REST Admin API legacy on 2024-10-01, deprecated its product and variant endpoints
 * in 2024-04, and requires public apps to use GraphQL only — so there is no REST path left here to
 * drift out of date. Every document this adapter sends is validated against Shopify's published
 * schema for `SHOPIFY_API_VERSION` by `scripts/validate-shopify-documents.mjs`.
 */
export const SHOPIFY_API_VERSION = "2026-10";

/** How long one call may wait for the cost bucket to refill before reporting a retriable failure. */
const MAX_THROTTLE_WAIT_MS = 10_000;
const MAX_THROTTLE_RETRIES = 3;

export interface ShopifyGraphqlTarget {
  fetchImpl: typeof fetch;
  /** `https://{shop}` in production; the stand-in's per-shop origin under test. */
  origin: string;
  accessToken: string;
  /** Overridable for tests only; production always waits on the real clock. */
  sleep?: (ms: number) => Promise<void>;
}

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({
    message: z.string().optional(),
    extensions: z.object({ code: z.string().optional() }).partial().optional(),
  })).optional(),
  extensions: z.object({
    cost: z.object({
      requestedQueryCost: z.number().optional(),
      throttleStatus: z.object({ currentlyAvailable: z.number(), restoreRate: z.number() }).optional(),
    }).optional(),
  }).optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;

/** Milliseconds until the bucket holds the query's cost again, from Shopify's own report of it. */
function throttleWaitMs(envelope: Envelope): number {
  const cost = envelope.extensions?.cost;
  const status = cost?.throttleStatus;
  if (!status || cost?.requestedQueryCost === undefined || status.restoreRate <= 0) return 1_000;
  const deficit = Math.max(0, cost.requestedQueryCost - status.currentlyAvailable);
  return Math.ceil((deficit / status.restoreRate) * 1_000);
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function readEnvelope(response: Response): Promise<Envelope | undefined> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = envelopeSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * POST one document and parse its `data` with `schema`.
 *
 * Throttling (`THROTTLED` in `errors`, or HTTP 429) waits for the bucket Shopify reports and
 * retries. Anything else not-ok is an error: a GraphQL `errors` array is never read as an empty
 * answer, because "the store has no products" and "the query failed" must not look alike. A `data`
 * the schema rejects is an error too — that is Shopify's schema moving under a pinned version, and
 * the right response is to stop rather than import a half-read product.
 */
export async function shopifyGraphql<T>(
  target: ShopifyGraphqlTarget,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<Result<T, ChannelConnectorError>> {
  const sleep = target.sleep ?? defaultSleep;
  // Called unbound, never as `target.fetchImpl(...)`: workerd's global `fetch` refuses any `this`
  // but the global scope ("Illegal invocation"), and Node's does not, so a method call passes on
  // Node and fails every Admin API call on a Worker. test/workerd-fetch.e2e.test.ts holds it.
  const { fetchImpl } = target;
  const url = `${target.origin}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      // `manual`, never `error`: workerd implements only `follow` and `manual` and throws on `error`
      // from the Request constructor. A 3xx is then simply not ok, which refuses the redirect.
      response = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: { accept: "application/json", "content-type": "application/json", "x-shopify-access-token": target.accessToken },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      return Err({ code: "SHOPIFY_API_FAILED", message: error instanceof Error ? error.message : "Shopify API request failed.", retriable: true });
    }
    if (response.status === 401 || response.status === 403) {
      return Err({ code: CHANNEL_CREDENTIALS_REJECTED, message: `Shopify refused the access token (${response.status}).`, retriable: false });
    }
    if (response.status !== 429 && !response.ok) {
      return Err({ code: "SHOPIFY_API_FAILED", message: `Shopify API request failed (${response.status}).`, retriable: response.status >= 500 });
    }
    const envelope = await readEnvelope(response);
    if (envelope === undefined && response.status !== 429) {
      return Err({ code: "SHOPIFY_API_FAILED", message: "Shopify answered a body that is not a GraphQL response.", retriable: true });
    }
    const errors = envelope?.errors ?? [];
    if (response.status === 429 || errors.some((error) => error.extensions?.code === "THROTTLED")) {
      const wait = envelope === undefined ? 1_000 : throttleWaitMs(envelope);
      if (attempt >= MAX_THROTTLE_RETRIES || waited + wait > MAX_THROTTLE_WAIT_MS) {
        return Err({ code: "SHOPIFY_THROTTLED", message: "Shopify's API cost bucket is exhausted; retry later.", retriable: true });
      }
      waited += wait;
      await sleep(wait);
      continue;
    }
    if (errors.length > 0) {
      const message = errors.map((error) => error.message ?? "unknown error").join("; ");
      const denied = errors.some((error) => error.extensions?.code === "ACCESS_DENIED");
      return Err({ code: denied ? "SHOPIFY_ACCESS_DENIED" : "SHOPIFY_GRAPHQL_ERROR", message: `Shopify GraphQL error: ${message}`, retriable: false });
    }
    const data = schema.safeParse(envelope?.data);
    if (!data.success) {
      return Err({ code: "SHOPIFY_RESPONSE_INVALID", message: `Shopify answered data this adapter cannot read: ${data.error.issues[0]?.message ?? "invalid shape"}.`, retriable: false });
    }
    return Ok(data.data);
  }
}

/** `gid://shopify/<Type>/<id>` for a numeric id; the adapter keys everything by the numeric id. */
export function shopifyGid(type: "Product" | "ProductVariant" | "InventoryItem" | "Order", id: string): string {
  return `gid://shopify/${type}/${id}`;
}
