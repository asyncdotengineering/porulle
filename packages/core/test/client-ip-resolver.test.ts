/**
 * Client-IP resolver (#13)
 *
 * Rate limiting keys on the client IP. Edge runtimes inject
 * runtime.getClientIp to read the platform header; otherwise the Node
 * default reads the socket address (trusting X-Forwarded-For only from a
 * configured proxy).
 */

import { describe, it, expect } from "vitest";
import { createClientIpResolver } from "../src/runtime/client-ip.js";

function ctx(headers: Record<string, string>, remoteAddress?: string) {
  return {
    req: {
      raw: { socket: remoteAddress ? { remoteAddress } : undefined },
      header: (n: string) => headers[n.toLowerCase()],
    },
  };
}

describe("client IP resolver (#13)", () => {
  it("uses an injected runtime.getClientIp (Cloudflare recipe)", () => {
    const resolve = createClientIpResolver({
      runtime: { getClientIp: (c) => c.req.header("cf-connecting-ip") ?? "unknown" },
    });
    expect(resolve(ctx({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("defaults to the Node socket remoteAddress", () => {
    const resolve = createClientIpResolver({});
    expect(resolve(ctx({}, "10.0.0.5"))).toBe("10.0.0.5");
    expect(resolve(ctx({}))).toBe("unknown");
  });

  it("trusts X-Forwarded-For only from the configured trusted proxy", () => {
    const resolve = createClientIpResolver({ runtime: { trustedProxyIp: "127.0.0.1" } });
    // Direct connection IS the trusted proxy → use the forwarded client IP.
    expect(resolve(ctx({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" }, "127.0.0.1"))).toBe(
      "198.51.100.9",
    );
    // Direct connection is NOT the trusted proxy → ignore XFF, use the socket.
    expect(resolve(ctx({ "x-forwarded-for": "198.51.100.9" }, "10.0.0.2"))).toBe("10.0.0.2");
  });
});
