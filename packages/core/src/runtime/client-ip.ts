/**
 * Client-IP resolution for rate limiting.
 *
 * The Node default reads `c.req.raw.socket.remoteAddress` — which is always
 * undefined on edge runtimes (Cloudflare Workers, Deno Deploy, Vercel Edge),
 * collapsing every client onto a single rate-limit key (a trivial DoS). Edge
 * deployments inject `runtime.getClientIp` to read the platform header instead
 * (CF: `cf-connecting-ip`, Vercel Edge: `x-real-ip`, Fly: `fly-client-ip`).
 */

export interface ClientIpContext {
  req: { raw: unknown; header(name: string): string | undefined };
}

export type ClientIpResolver = (c: ClientIpContext) => string;

export interface RuntimeConfig {
  /** Resolve the client IP from the request (used as the rate-limit key). */
  getClientIp?: ClientIpResolver;
  /** Direct-connection IP of the trusted reverse proxy (Node default only). */
  trustedProxyIp?: string;
}

/**
 * Build the client-IP resolver. Prefers an injected `runtime.getClientIp`;
 * otherwise falls back to the Node behavior (socket address, trusting
 * X-Forwarded-For only from `trustedProxyIp` / `TRUSTED_PROXY_IP`).
 */
export function createClientIpResolver(config: {
  runtime?: RuntimeConfig;
}): ClientIpResolver {
  if (config.runtime?.getClientIp) {
    return config.runtime.getClientIp;
  }

  const trustedProxyIp =
    config.runtime?.trustedProxyIp ??
    (typeof process !== "undefined" ? process.env?.TRUSTED_PROXY_IP : undefined);

  return (c: ClientIpContext): string => {
    const raw = c.req.raw as { socket?: { remoteAddress?: string } } | undefined;
    const remoteAddress = raw?.socket?.remoteAddress;
    if (trustedProxyIp && remoteAddress === trustedProxyIp) {
      const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (xff) return xff;
    }
    return remoteAddress ?? "unknown";
  };
}
