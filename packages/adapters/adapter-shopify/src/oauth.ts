import { createHmac, timingSafeEqual } from "node:crypto";
import { Err, Ok } from "@porulle/core";
import type { ChannelConnectorError, Result } from "@porulle/core";
import { z } from "zod";

/**
 * Shopify's two grants an app connects a store with.
 *
 * - The authorization code grant, for an app the merchant installs from us (public or custom
 *   distribution), asking for an EXPIRING offline token: Shopify requires them of every new public
 *   app calling the GraphQL Admin API — a one-hour access token and a 90-day refresh token that
 *   rotates on every refresh.
 *   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
 * - The client credentials grant, for an app that belongs to the SAME Shopify organization as the
 *   store: a merchant's own Dev Dashboard app, whose client id and secret the merchant hands over.
 *   The token lives 24 hours and there is no refresh token; a new one is minted with the same client
 *   id and secret. Shopify refuses it with `shop_not_permitted` across organizations.
 *   https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
 * - The token exchange grant, for an app Shopify installs itself (managed installation) and loads
 *   inside the admin: App Bridge hands the page a one-minute ID token, and the app trades it for the
 *   same expiring offline token. Shopify keeps ONE current offline token per app and store, so a
 *   successful exchange retires the refresh tokens an earlier grant of that app issued.
 *   https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
 */

/**
 * The scopes the connector's live paths need, and nothing else. Nothing about a product is ever
 * pushed to a merchant's Shopify — only orders reach it — so there is no `write_products` here.
 *
 * - `read_products`: the catalogue import.
 * - `read_inventory`: variant stock and the inventory item behind a stock webhook.
 * - `write_orders`: a paid platform order is created in the store (`orderCreate`). A write scope
 *   includes its read scope, which `orders/fulfilled` and `orders/cancelled` need.
 * - `read_returns`, `write_returns`: a shopper's return is asked of the store (`returnRequest`) and
 *   its `returns/*` webhooks say how the store answered.
 */
export const REQUIRED_SCOPES = ["read_products", "read_inventory", "write_orders", "read_returns", "write_returns"] as const;

/** Refresh this long before Shopify's stated expiry, so a call never starts on a token about to lapse. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** What the store row holds. Read back with {@link parseShopifyCredentials}; never cast. */
export interface ShopifyCredentials {
  /**
   * The client id of the app that issued this grant. A token renews only with the app that issued
   * it, and which app that is cannot be inferred from the shop: it is stored with the grant. Absent on
   * a grant stored before this field existed, which the next renewal fills in.
   */
  clientId?: string;
  /**
   * How the token was granted. `client_credentials` has no refresh token: it is renewed by minting
   * again with the app's client id and secret. Absent: the authorization code grant.
   */
  grant?: "client_credentials";
  accessToken: string;
  /** Absent for a non-expiring token (an admin-created custom app); such a token is never refreshed. */
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  grantedScopes: string[];
}

const credentialsSchema = z.object({
  clientId: z.string().min(1).optional(),
  grant: z.literal("client_credentials").optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.string().optional(),
  refreshTokenExpiresAt: z.string().optional(),
  grantedScopes: z.array(z.string()).default([]),
});

export function parseShopifyCredentials(value: Record<string, unknown>): ShopifyCredentials | undefined {
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { clientId, grant, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, ...rest } = parsed.data;
  return {
    ...rest,
    ...(clientId !== undefined ? { clientId } : {}),
    ...(grant !== undefined ? { grant } : {}),
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

function credentialsFrom(body: z.infer<typeof tokenResponseSchema>, now: number, clientId: string): ShopifyCredentials {
  return {
    clientId,
    accessToken: body.access_token,
    grantedScopes: body.scope.split(",").map((scope) => scope.trim()).filter(Boolean),
    ...(body.refresh_token !== undefined ? { refreshToken: body.refresh_token } : {}),
    ...(body.expires_in !== undefined ? { accessTokenExpiresAt: new Date(now + body.expires_in * 1000).toISOString() } : {}),
    ...(body.refresh_token_expires_in !== undefined ? { refreshTokenExpiresAt: new Date(now + body.refresh_token_expires_in * 1000).toISOString() } : {}),
  };
}

/**
 * Why the token endpoint refused a grant, from the body Shopify answered with. Shopify documents two
 * client-credentials refusals by name, in a body that reads "Oauth error shop_not_permitted: …"; the
 * name is matched wherever it appears rather than parsed from one assumed shape.
 */
function tokenRefusal(status: number, body: string): ChannelConnectorError {
  if (body.includes("shop_not_permitted")) {
    return { code: "SHOPIFY_SHOP_NOT_PERMITTED", message: "Shopify refused the client credentials grant for this store: the app and the store are in different Shopify organizations.", retriable: false };
  }
  if (body.includes("app_not_installed")) {
    return { code: "SHOPIFY_APP_NOT_INSTALLED", message: "Shopify says the app is not installed on this store.", retriable: false };
  }
  return { code: "SHOPIFY_REAUTHORIZATION_REQUIRED", message: `Shopify refused the grant (${status}); the store must be reconnected.`, retriable: false };
}

/**
 * `badRequest` is what a 400 means to this grant when it is not the generic refusal: for the token
 * exchange it is a stale or invalid ID token, which a fresh one fixes.
 */
async function postTokenEndpoint(fetchImpl: typeof fetch, origin: string, form: Record<string, string>, badRequest?: ChannelConnectorError): Promise<Result<z.infer<typeof tokenResponseSchema>, ChannelConnectorError>> {
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
  if (response.status === 400 && badRequest !== undefined) return Err(badRequest);
  if (response.status === 400 || response.status === 401) {
    return Err(tokenRefusal(response.status, await response.text().catch(() => "")));
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
  const credentials = credentialsFrom(token.value, params.now, params.clientId);
  // Merchants can untick scopes on the grant screen; a token missing one fails later in a way that
  // looks like a product problem, so it is refused here, where the cause is still nameable.
  const missing = missingScopes(credentials.grantedScopes, params.requiredScopes);
  if (missing.length > 0) return oauthError("SHOPIFY_SCOPES_NOT_GRANTED", `The store did not grant: ${missing.join(", ")}.`);
  return Ok(credentials);
}

/** Shopify's ID tokens are signed with this; anything else (`none`, RS256) is refused before it is read. */
const ID_TOKEN_ALGORITHM = "HS256";
/** How far a token's `nbf` may sit in the future before it is refused: clocks differ by seconds. */
const ID_TOKEN_SKEW_MS = 10_000;

const idTokenHeaderSchema = z.object({ alg: z.string() });
const idTokenPayloadSchema = z.object({
  iss: z.string(),
  dest: z.string(),
  aud: z.string(),
  sub: z.string(),
  exp: z.number(),
  nbf: z.number(),
});

const ID_TOKEN_INVALID: ChannelConnectorError = { code: "SHOPIFY_ID_TOKEN_INVALID", message: "The Shopify ID token is invalid or expired.", retriable: false };

function jwtPart(encoded: string): unknown {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Check an ID token the way Shopify documents: HS256 over `header.payload` under the client secret
 * (compared in constant time), `exp` in the future, `nbf` in the past, `aud` equal to the client id,
 * and the hostnames of `iss` and `dest` equal and a `*.myshopify.com` shop. Returns the shop the
 * token was issued for and the staff member (`sub`). Every failure is `SHOPIFY_ID_TOKEN_INVALID`:
 * the caller's answer is the same (a fresh token fixes it), and the cause is not the caller's to learn.
 * https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens
 */
export function verifyShopifyIdToken(params: { token: string; clientId: string; clientSecret: string; now: number }): Result<{ shop: string; userId: string }, ChannelConnectorError> {
  const parts = params.token.split(".");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) return Err(ID_TOKEN_INVALID);
  const header = idTokenHeaderSchema.safeParse(jwtPart(encodedHeader));
  if (!header.success || header.data.alg !== ID_TOKEN_ALGORITHM) return Err(ID_TOKEN_INVALID);
  const expected = createHmac("sha256", params.clientSecret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Err(ID_TOKEN_INVALID);
  const payload = idTokenPayloadSchema.safeParse(jwtPart(encodedPayload));
  if (!payload.success) return Err(ID_TOKEN_INVALID);
  const claims = payload.data;
  const issuerHost = hostOf(claims.iss);
  const destHost = hostOf(claims.dest);
  if (
    claims.exp * 1000 <= params.now
    || claims.nbf * 1000 > params.now + ID_TOKEN_SKEW_MS
    || claims.aud !== params.clientId
    || issuerHost === undefined
    || issuerHost !== destHost
    || !validShopDomain(destHost)
  ) return Err(ID_TOKEN_INVALID);
  return Ok({ shop: destHost, userId: claims.sub });
}

/**
 * Trade a verified ID token for an expiring offline token (the token exchange grant). Shopify answers
 * a stale or invalid ID token with 400, a routine condition a fresh token fixes: it is
 * `SHOPIFY_ID_TOKEN_INVALID` here, not a refusal of the app. Scopes the store did not grant are refused
 * exactly as the code grant refuses them.
 */
export async function exchangeIdToken(params: {
  fetchImpl: typeof fetch;
  origin: string;
  clientId: string;
  clientSecret: string;
  idToken: string;
  requiredScopes: readonly string[];
  now: number;
}): Promise<Result<ShopifyCredentials, ChannelConnectorError>> {
  const token = await postTokenEndpoint(params.fetchImpl, params.origin, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: params.idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    expiring: "1",
  }, ID_TOKEN_INVALID);
  if (!token.ok) return token;
  const credentials = credentialsFrom(token.value, params.now, params.clientId);
  const missing = missingScopes(credentials.grantedScopes, params.requiredScopes);
  if (missing.length > 0) return oauthError("SHOPIFY_SCOPES_NOT_GRANTED", `The store did not grant: ${missing.join(", ")}.`);
  return Ok(credentials);
}

/**
 * A token from the client credentials grant: the app's own client id and secret, no code and no
 * scope (Shopify ignores one). The token carries the scopes the store granted the app's installation.
 * A refusal names its cause: `SHOPIFY_SHOP_NOT_PERMITTED` (another organization's app),
 * `SHOPIFY_APP_NOT_INSTALLED`, or `SHOPIFY_REAUTHORIZATION_REQUIRED` for a client id or secret
 * Shopify does not accept.
 */
export async function mintClientCredentials(params: {
  fetchImpl: typeof fetch;
  origin: string;
  clientId: string;
  clientSecret: string;
  now: number;
}): Promise<Result<ShopifyCredentials, ChannelConnectorError>> {
  const token = await postTokenEndpoint(params.fetchImpl, params.origin, {
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  if (!token.ok) return token;
  return Ok({ grant: "client_credentials", ...credentialsFrom(token.value, params.now, params.clientId) });
}

/**
 * New credentials when the access token is within the refresh margin of expiry, `null` when the
 * current ones are good. A client-credentials token is minted again; an authorization-code token is
 * refreshed with its refresh token, and a refresh token Shopify refuses means the merchant must
 * reconnect.
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
  if (credentials.grant === "client_credentials") return mintClientCredentials(params);
  if (credentials.refreshToken === undefined) return oauthError("SHOPIFY_REAUTHORIZATION_REQUIRED", "The store's access token expired and no refresh token is held; the store must be reconnected.");
  const token = await postTokenEndpoint(params.fetchImpl, params.origin, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  });
  if (!token.ok) return token;
  const refreshed = credentialsFrom(token.value, params.now, params.clientId);
  // A refresh answer may omit the scope list; the grant did not change, so keep the one we hold.
  return Ok(refreshed.grantedScopes.length > 0 ? refreshed : { ...refreshed, grantedScopes: credentials.grantedScopes });
}
