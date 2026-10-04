import { CHANNEL_CREDENTIALS_REJECTED, Err, Ok } from "@porulle/core";
import type { ChannelConnectorError, ChannelStore, Result } from "@porulle/core";
import { z } from "zod";

/**
 * Everything the adapter learns about one store, kept in its credentials. The keys come from
 * WooCommerce's approval screen; the rest is discovered once by `discoverStore` and persisted through
 * the plugin's `liveCredentials` hook, so no call has to rediscover it.
 */
export const wooCredentialsSchema = z.object({
  consumerKey: z.string().regex(/^ck_[a-f0-9]{40}$/),
  consumerSecret: z.string().regex(/^cs_[a-f0-9]{40}$/),
  /** `query` when the host strips the Authorization header (some proxies and caches do). */
  authMode: z.enum(["header", "query"]).optional(),
  /** `query` when pretty permalinks are off and the REST API answers only at `/?rest_route=`. */
  restRoute: z.enum(["pretty", "query"]).optional(),
  currency: z.string().optional(),
  priceDecimals: z.number().int().min(0).max(4).optional(),
  hpos: z.boolean().optional(),
});
export type WooCredentials = z.infer<typeof wooCredentialsSchema>;

export interface WooTransportOptions {
  fetchImpl: typeof fetch;
  userAgent: string;
  /** Tests point the adapter at a store on localhost; production never does. */
  allowPrivateHosts: boolean;
}

export type WooProbeFailure = "not_json" | "rest_unavailable" | "tls" | "not_woocommerce" | "private_host" | "unreachable";

export const WOO_BLOCKED_BY_FIREWALL = "WOO_BLOCKED_BY_FIREWALL";
export const WOO_API_FAILED = "WOO_API_FAILED";

const FIREWALL_MESSAGE = "The store answered with a web page instead of its API. A firewall in front of it (Cloudflare Bot Fight Mode, Wordfence or another security plugin) is blocking us; allow requests to /wp-json/wc/ from our service.";

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return true;
  // IPv6 loopback, unique-local, link-local, IPv4-mapped.
  if (h.includes(":")) return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  // Any all-numeric host: dotted, single integer, hex or octal encodings all name an IP.
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) {
    const parts = h.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a = 0, b = 0] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return false;
}

/**
 * The canonical store URL a merchant's typing names: https only, lower-case host, any sub-directory
 * install path kept, no trailing slash or `/wp-json` suffix. Undefined when it cannot name a store.
 */
export function normalizeStoreDomain(input: string, options: { allowPrivateHosts?: boolean } = {}): string | undefined {
  const typed = input.trim();
  if (typed === "") return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return undefined;
  }
  const local = options.allowPrivateHosts === true && isPrivateHost(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return undefined;
  if (url.username || url.password || !url.hostname.includes(".") && !local) return undefined;
  if (isPrivateHost(url.hostname) && options.allowPrivateHosts !== true) return undefined;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/wp-json$/i, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/** A store URL the adapter refuses outright, for a message better than "does not name a store". */
export function refusedStoreUrl(input: string): WooProbeFailure | "http" | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    if (url.protocol === "http:") return "http";
    if (isPrivateHost(url.hostname)) return "private_host";
  } catch {
    return undefined;
  }
  return undefined;
}

const restRootSchema = z.object({ name: z.string().optional(), namespaces: z.array(z.string()).optional() });

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function looksLikeJson(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("json");
}

/** One request with no redirect followed: a redirect to another host, or to http, must not carry our keys. */
async function fetchOnce(options: WooTransportOptions, url: URL, init: RequestInit = {}): Promise<Response> {
  return options.fetchImpl(url, {
    ...init,
    redirect: "manual",
    headers: { accept: "application/json", "user-agent": options.userAgent, ...(init.headers ?? {}) },
  });
}

function restUrl(base: string, path: string, restRoute: "pretty" | "query", query: Record<string, string> = {}): URL {
  const url = restRoute === "pretty" ? new URL(`${base}/wp-json${path}`) : new URL(`${base}/`);
  if (restRoute === "query") url.searchParams.set("rest_route", path);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

/**
 * Finds the store's REST API without credentials: `/wp-json/`, else `/?rest_route=/` for a store with
 * plain permalinks. It must list `wc/v3`. Each failure is classified for a message the merchant can act on.
 */
export async function probeStore(options: WooTransportOptions, storeUrl: string): Promise<Result<{ restRoute: "pretty" | "query"; name: string }, { code: WooProbeFailure; message: string }>> {
  const base = normalizeStoreDomain(storeUrl, { allowPrivateHosts: options.allowPrivateHosts });
  if (!base) return Err({ code: "private_host", message: "That address cannot be a public WooCommerce store." });
  let sawHtml = false;
  for (const restRoute of ["pretty", "query"] as const) {
    let response: Response;
    try {
      response = await fetchOnce(options, restUrl(base, "/", restRoute));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/certificate|ssl|tls/i.test(message)) return Err({ code: "tls", message: "The store's HTTPS certificate was refused. It needs a valid certificate." });
      return Err({ code: "unreachable", message: `The store could not be reached: ${message}` });
    }
    if (response.ok && looksLikeJson(response)) {
      const root = restRootSchema.safeParse(JSON.parse(stripBom(await response.text())));
      if (!root.success) return Err({ code: "not_json", message: FIREWALL_MESSAGE });
      if (!(root.data.namespaces ?? []).includes("wc/v3")) return Err({ code: "not_woocommerce", message: "That site runs WordPress but not WooCommerce (or its REST API is turned off)." });
      return Ok({ restRoute, name: root.data.name ?? base });
    }
    if (!looksLikeJson(response) && response.status !== 404) sawHtml = true;
  }
  return sawHtml
    ? Err({ code: "not_json", message: FIREWALL_MESSAGE })
    : Err({ code: "rest_unavailable", message: "The store's REST API did not answer. Turn on pretty permalinks (Settings → Permalinks → Post name) and make sure no plugin disables the REST API." });
}

export interface WooPage<T> {
  data: T;
  totalPages: number;
}

/** A store's REST client: keys sent as the store accepts them, every answer parsed, no secret in an error. */
export interface WooClient {
  readonly base: string;
  readonly credentials: WooCredentials;
  get<T>(path: string, schema: z.ZodType<T>, query?: Record<string, string>): Promise<Result<WooPage<T>, WooRequestError>>;
  send<T>(method: "POST" | "PUT" | "DELETE", path: string, body: unknown, schema: z.ZodType<T>, query?: Record<string, string>): Promise<Result<T, WooRequestError>>;
  /** Every page of a list endpoint, 100 at a time. */
  all<T>(path: string, schema: z.ZodType<T>, query?: Record<string, string>): Promise<Result<T[], WooRequestError>>;
}

const wooErrorSchema = z.object({ code: z.string(), message: z.string().optional(), data: z.unknown().optional() });
export type WooErrorBody = z.infer<typeof wooErrorSchema>;

/** The REST error WooCommerce answered, kept for callers that act on its code (e.g. a leftover draft order). */
export interface WooRequestError extends ChannelConnectorError {
  status?: number;
  body?: WooErrorBody;
}

function classify(status: number, json: boolean, body: WooErrorBody | undefined, what: string): WooRequestError {
  if (status === 401 && json) {
    return { code: CHANNEL_CREDENTIALS_REJECTED, message: `The store refused our key for ${what}${body?.message ? `: ${body.message}` : ""}.`, retriable: false, status, ...(body ? { body } : {}) };
  }
  if (!json && (status === 403 || status === 429 || status === 503 || status === 406)) {
    return { code: WOO_BLOCKED_BY_FIREWALL, message: FIREWALL_MESSAGE, retriable: true, status };
  }
  const retriable = status >= 500 || status === 408 || status === 429;
  return { code: WOO_API_FAILED, message: `WooCommerce answered ${status} for ${what}${body?.message ? `: ${body.message}` : ""}.`, retriable, status, ...(body ? { body } : {}) };
}

export function wooClient(store: ChannelStore, options: WooTransportOptions): Result<WooClient, ChannelConnectorError> {
  const credentials = wooCredentialsSchema.safeParse(store.credentials);
  if (!credentials.success) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "The store holds no valid WooCommerce keys; it must be reconnected.", retriable: false });
  const base = normalizeStoreDomain(store.storeDomain, { allowPrivateHosts: options.allowPrivateHosts });
  if (!base) return Err({ code: "WOO_INVALID_STORE_DOMAIN", message: "The store's address is not an https URL.", retriable: false });
  return Ok(clientFor(base, credentials.data, options));
}

export function clientFor(base: string, credentials: WooCredentials, options: WooTransportOptions): WooClient {
  const authMode = credentials.authMode ?? "header";
  const restRoute = credentials.restRoute ?? "pretty";
  const authHeader = `Basic ${btoa(`${credentials.consumerKey}:${credentials.consumerSecret}`)}`;

  async function call(method: string, path: string, query: Record<string, string>, body: unknown): Promise<Result<{ data: unknown; response: Response }, WooRequestError>> {
    const url = restUrl(base, path, restRoute, query);
    if (authMode === "query") {
      url.searchParams.set("consumer_key", credentials.consumerKey);
      url.searchParams.set("consumer_secret", credentials.consumerSecret);
    }
    // Named in errors without its query string, which may carry the keys.
    const what = `${method} ${path}`;
    let response: Response;
    try {
      response = await fetchOnce(options, url, {
        method,
        headers: { ...(authMode === "header" ? { authorization: authHeader } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      return Err({ code: WOO_API_FAILED, message: `The store could not be reached for ${what}: ${error instanceof Error ? error.message : String(error)}.`, retriable: true });
    }
    if (response.status >= 300 && response.status < 400) {
      return Err({ code: WOO_API_FAILED, message: `The store redirected ${what} elsewhere (${response.status}); its address may have changed. Reconnect it at its current address.`, retriable: false, status: response.status });
    }
    const json = looksLikeJson(response);
    const text = stripBom(await response.text());
    let data: unknown;
    if (json) {
      try {
        data = JSON.parse(text);
      } catch {
        return Err({ code: WOO_BLOCKED_BY_FIREWALL, message: FIREWALL_MESSAGE, retriable: true, status: response.status });
      }
    }
    if (!response.ok) return Err(classify(response.status, json, json ? wooErrorSchema.safeParse(data).data : undefined, what));
    if (!json) return Err({ code: WOO_BLOCKED_BY_FIREWALL, message: FIREWALL_MESSAGE, retriable: true, status: response.status });
    return Ok({ data, response });
  }

  function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): Result<T, WooRequestError> {
    const parsed = schema.safeParse(data);
    return parsed.success ? Ok(parsed.data) : Err({ code: "WOO_UNEXPECTED_RESPONSE", message: `WooCommerce answered ${what} in a shape we do not recognise: ${parsed.error.message.slice(0, 400)}`, retriable: false });
  }

  const client: WooClient = {
    base,
    credentials,
    async get(path, schema, query = {}) {
      const answered = await call("GET", path, query, undefined);
      if (!answered.ok) return answered;
      const parsed = parse(schema, answered.value.data, `GET ${path}`);
      if (!parsed.ok) return parsed;
      const totalPages = Number.parseInt(answered.value.response.headers.get("x-wp-totalpages") ?? "1", 10);
      return Ok({ data: parsed.value, totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1 });
    },
    async send(method, path, body, schema, query = {}) {
      const answered = await call(method, path, query, body);
      if (!answered.ok) return answered;
      return parse(schema, answered.value.data, `${method} ${path}`);
    },
    async all(path, schema, query = {}) {
      const rows: Array<z.infer<typeof schema>> = [];
      for (let page = 1; ; page += 1) {
        const read = await client.get(path, z.array(schema), { per_page: "100", ...query, page: String(page) });
        if (!read.ok) return read;
        rows.push(...read.value.data);
        if (page >= read.value.totalPages || read.value.data.length === 0) return Ok(rows);
      }
    },
  };
  return client;
}

const systemStatusSchema = z.object({
  settings: z.object({
    currency: z.string(),
    number_of_decimals: z.coerce.number().int(),
    HPOS_enabled: z.boolean().optional(),
  }),
});

/**
 * What the adapter needs to know about a store before it can call it well: where its REST API
 * answers, how it accepts our keys, and how it prices. Read once and persisted in the credentials.
 * A key both auth modes refuse is {@link CHANNEL_CREDENTIALS_REJECTED}.
 */
export async function discoverStore(options: WooTransportOptions, storeDomain: string, credentials: WooCredentials): Promise<Result<WooCredentials, ChannelConnectorError>> {
  const base = normalizeStoreDomain(storeDomain, { allowPrivateHosts: options.allowPrivateHosts });
  if (!base) return Err({ code: "WOO_INVALID_STORE_DOMAIN", message: "The store's address is not an https URL.", retriable: false });
  const probe = await probeStore(options, base);
  if (!probe.ok) return Err({ code: probe.error.code === "not_json" ? WOO_BLOCKED_BY_FIREWALL : "WOO_STORE_UNREACHABLE", message: probe.error.message, retriable: probe.error.code === "not_json" || probe.error.code === "unreachable" });
  let firstError: ChannelConnectorError | undefined;
  for (const authMode of ["header", "query"] as const) {
    const client = clientFor(base, { ...credentials, authMode, restRoute: probe.value.restRoute }, options);
    const status = await client.get("/wc/v3/system_status", systemStatusSchema);
    if (status.ok) {
      const { currency, number_of_decimals, HPOS_enabled } = status.value.data.settings;
      return Ok({ ...credentials, authMode, restRoute: probe.value.restRoute, currency: currency.toUpperCase(), priceDecimals: number_of_decimals, hpos: HPOS_enabled === true });
    }
    firstError ??= status.error;
    // Only a refused key is worth a second try in the other mode: a stripped header reads as no key.
    if (status.error.code !== CHANNEL_CREDENTIALS_REJECTED) return status;
  }
  return Err(firstError ?? { code: CHANNEL_CREDENTIALS_REJECTED, message: "The store refused our key.", retriable: false });
}
