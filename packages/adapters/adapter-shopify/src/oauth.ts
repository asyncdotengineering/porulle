import { createHmac, timingSafeEqual } from "node:crypto";
import { Err, Ok } from "@porulle/core";
import type { ChannelConnectorError, Result } from "@porulle/core";
import { z } from "zod";

/**
 * Shopify's OAuth for a standalone (non-embedded) app: the authorization code grant, asking for an
 * EXPIRING offline token. Shopify requires expiring offline tokens of every new public app calling the
 * GraphQL Admin API: a one-hour access token and a 90-day refresh token that rotates on every refresh.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
 */

/**
 * The scopes the connector's live paths need, and nothing else.
 *
 * - `read_products`, `write_products`: the catalogue import, and the Loom metafield write-back.
 * - `read_inventory`: variant stock and the inventory item behind a stock webhook.
 * - `write_orders`: a paid platform order is created in the store (`orderCreate`). A write scope
 *   includes its read scope, which `orders/fulfilled` and `orders/cancelled` need.
 * - `read_returns`, `write_returns`: a shopper's return is asked of the store (`returnRequest`) and
 *   its `returns/*` webhooks say how the store answered.
 */
export const REQUIRED_SCOPES = ["read_products", "write_products", "read_inventory", "write_orders", "read_returns", "write_returns"] as const;

/** Refresh this long before Shopify's stated expiry, so a call never starts on a token about to lapse. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** What the store row holds. Read back with {@link parseShopifyCredentials}; never cast. */
export interface ShopifyCredentials {
  accessToken: string;
  /** Absent for a non-expiring token (an admin-created custom app); such a token is never refreshed. */
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  grantedScopes: string[];
}

const credentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.string().optional(),
  refreshTokenExpiresAt: z.string().optional(),
  grantedScopes: z.array(z.string()).default([]),
});

export function parseShopifyCredentials(value: Record<string, unknown>): ShopifyCredentials | undefined {
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, ...rest } = parsed.data;
  return {
    ...rest,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt } : {}),
    ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
  };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(""),
  expires_in: z.number().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().optional(),
});

/** Anchored at both ends: without `$`, `shop.myshopify.com.attacker.example` would pass. */
export function validShopDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

/** A merchant types "acme", "acme.myshopify.com" or "https://acme.myshopify.com/admin"; all mean one shop. */
export function normalizeShopDomain(input: string): string | undefined {
  const trimmed = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const domain = trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
  return validShopDomain(domain) ? domain : undefined;
}

function oauthError(code: string, message: string, retriable = false): Result<never, ChannelConnectorError> {
  return Err({ code, message, retriable });
}

export function buildAuthorizeUrl(params: { origin: string; clientId: string; scopes: readonly string[]; redirectUri: string; state: string }): string {
  const url = new URL(`${params.origin}/admin/oauth/authorize`);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("scope", params.scopes.join(","));
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

/** Remove `hmac`, sort the rest, HMAC-SHA256 with the client secret, compare in constant time. */
export function validCallbackHmac(searchParams: URLSearchParams, secret: string): boolean {
  const provided = searchParams.get("hmac");
  if (!provided || !/^[a-f0-9]+$/i.test(provided)) return false;
  const message = [...searchParams.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest();
  const actual = Buffer.from(provided, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A write scope grants its read scope, so `read_x` is satisfied by a granted `write_x`. */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((scope) => !have.has(scope) && !(scope.startsWith("read_") && have.has(`write_${scope.slice(5)}`)));
}

function credentialsFrom(body: z.infer<typeof tokenResponseSchema>, now: number): ShopifyCredentials {
  return {
    accessToken: body.access_token,
    grantedScopes: body.scope.split(",").map((scope) => scope.trim()).filter(Boolean),
    ...(body.refresh_token !== undefined ? { refreshToken: body.refresh_token } : {}),
    ...(body.expires_in !== undefined ? { accessTokenExpiresAt: new Date(now + body.expires_in * 1000).toISOString() } : {}),
    ...(body.refresh_token_expires_in !== undefined ? { refreshTokenExpiresAt: new Date(now + body.refresh_token_expires_in * 1000).toISOString() } : {}),
  };
}

async function postTokenEndpoint(fetchImpl: typeof fetch, origin: string, form: Record<string, string>): Promise<Result<z.infer<typeof tokenResponseSchema>, ChannelConnectorError>> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/admin/oauth/access_token`, {
      method: "POST",
      redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    return oauthError("SHOPIFY_TOKEN_REQUEST_FAILED", error instanceof Error ? error.message : "Shopify token request failed.", true);
  }
  if (response.status === 400 || response.status === 401) {
    return oauthError("SHOPIFY_REAUTHORIZATION_REQUIRED", `Shopify refused the grant (${response.status}); the store must be reconnected.`);
  }
  if (!response.ok) return oauthError("SHOPIFY_TOKEN_REQUEST_FAILED", `Shopify token request failed (${response.status}).`, response.status >= 500);
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return oauthError("SHOPIFY_TOKEN_INVALID", "Shopify's token response did not carry an access token.");
  return Ok(parsed.data);
}

/** Exchange the callback's code for an expiring offline token, after checking everything Shopify signed. */
export async function exchangeCallback(params: {
  fetchImpl: typeof fetch;
  origin: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: URL;
  expectedShop: string;
  requiredScopes: readonly string[];
  now: number;
}): Promise<Result<ShopifyCredentials, ChannelConnectorError>> {
  const search = params.callbackUrl.searchParams;
  const shop = search.get("shop")?.toLowerCase();
  if (!shop || !validShopDomain(shop) || shop !== params.expectedShop) {
    return oauthError("SHOPIFY_INVALID_STORE_DOMAIN", "The callback names a different shop than the one that started the connection.");
  }
  if (!validCallbackHmac(search, params.clientSecret)) return oauthError("SHOPIFY_INVALID_OAUTH_HMAC", "Shopify OAuth callback HMAC is invalid.");
  const timestamp = Number(search.get("timestamp"));
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(params.now / 1000) - timestamp) > 300) {
    return oauthError("SHOPIFY_STALE_OAUTH_CALLBACK", "Shopify OAuth callback timestamp is stale.");
  }
  const code = search.get("code");
  if (!code) return oauthError("SHOPIFY_OAUTH_CODE_REQUIRED", "Shopify OAuth callback code is required.");
  const token = await postTokenEndpoint(params.fetchImpl, params.origin, { client_id: params.clientId, client_secret: params.clientSecret, code, expiring: "1" });
  if (!token.ok) return token;
  const credentials = credentialsFrom(token.value, params.now);
  // Merchants can untick scopes on the grant screen; a token missing one fails later in a way that
  // looks like a product problem, so it is refused here, where the cause is still nameable.
  const missing = missingScopes(credentials.grantedScopes, params.requiredScopes);
  if (missing.length > 0) return oauthError("SHOPIFY_SCOPES_NOT_GRANTED", `The store did not grant: ${missing.join(", ")}.`);
  return Ok(credentials);
}

/**
 * New credentials when the access token is within the refresh margin of expiry, `null` when the
 * current ones are good. A refresh token Shopify refuses means the merchant must reconnect.
 */
export async function refreshIfExpiring(params: {
  fetchImpl: typeof fetch;
  origin: string;
  clientId: string;
  clientSecret: string;
  credentials: ShopifyCredentials;
  now: number;
  /** Refresh even though the stated expiry is far off: Shopify just rejected the token. */
  force?: boolean;
}): Promise<Result<ShopifyCredentials | null, ChannelConnectorError>> {
  const { credentials } = params;
  if (params.force !== true) {
    if (credentials.accessTokenExpiresAt === undefined) return Ok(null);
    const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - params.now > ACCESS_TOKEN_REFRESH_MARGIN_MS) return Ok(null);
  }
  if (credentials.refreshToken === undefined) return oauthError("SHOPIFY_REAUTHORIZATION_REQUIRED", "The store's access token expired and no refresh token is held; the store must be reconnected.");
  const token = await postTokenEndpoint(params.fetchImpl, params.origin, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  });
  if (!token.ok) return token;
  const refreshed = credentialsFrom(token.value, params.now);
  // A refresh answer may omit the scope list; the grant did not change, so keep the one we hold.
  return Ok(refreshed.grantedScopes.length > 0 ? refreshed : { ...refreshed, grantedScopes: credentials.grantedScopes });
}
