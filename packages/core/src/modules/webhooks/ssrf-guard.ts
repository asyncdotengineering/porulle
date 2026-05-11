/**
 * Shared SSRF prevention utilities.
 *
 * Used by both webhook delivery (DNS rebinding check) and connector URL
 * validation (store URL check) to reject private/internal IP addresses.
 */

/**
 * Returns true if the given IP address falls within a private, loopback,
 * link-local, or otherwise non-routable range.
 */
export function isPrivateIp(ip: string): boolean {
  // IPv6 loopback / link-local / mapped
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:")) return true;

  // IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1) — extract the IPv4 portion
  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) {
    return isPrivateIpv4(mappedMatch[1]!);
  }

  return isPrivateIpv4(ip);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => isNaN(n))) return false;

  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;

  if (a === 127) return true;            // loopback 127.0.0.0/8
  if (a === 10) return true;             // RFC 1918 class A
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 class B
  if (a === 192 && b === 168) return true; // RFC 1918 class C
  if (a === 169 && b === 254) return true; // link-local / AWS IMDS
  if (a === 0) return true;              // unspecified

  return false;
}

/**
 * Checks whether a URL string points to a private/internal IP address or
 * hostname. This performs a string-level check only (no DNS resolution).
 *
 * For DNS rebinding protection, use `isPrivateIp` after resolving the hostname.
 */
export function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // Direct hostname matches
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (hostname === "::1" || hostname === "::") return true;
    if (hostname.startsWith("::ffff:")) return true;
    if (hostname.startsWith("fe80:")) return true;
    if (hostname.endsWith(".local")) return true;
    if (hostname.endsWith(".internal")) return true;

    // Cloud metadata endpoints
    if (hostname === "169.254.169.254") return true;
    if (hostname === "metadata.google.internal") return true;

    // Check if hostname is a raw IP in private ranges
    return isPrivateIpv4(hostname);
  } catch {
    return true; // Invalid URLs are blocked
  }
}
