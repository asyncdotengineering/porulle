import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import { CommerceNotFoundError, CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { WebhooksRepository, WebhookEndpoint } from "./repository/index.js";

/**
 * Checks whether a URL points to a private/internal IP address.
 * Blocks: loopback (127.x), link-local (169.254.x), private (10.x, 172.16-31.x, 192.168.x),
 * cloud metadata (169.254.169.254, metadata.google.internal), and localhost.
 */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // Strip IPv6 brackets: URL.hostname returns "[::1]" not "::1"
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // Loopback (IPv4 + IPv6)
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
    if (hostname.endsWith(".localhost")) return true;

    // IPv6 loopback and link-local patterns
    if (hostname.startsWith("::ffff:")) return true; // IPv6-mapped IPv4 (e.g., ::ffff:127.0.0.1)
    if (hostname.startsWith("fe80:")) return true;   // IPv6 link-local
    if (hostname === "::") return true;               // Unspecified address

    // Cloud metadata endpoints
    if (hostname === "169.254.169.254") return true;
    if (hostname === "metadata.google.internal") return true;

    // Private IP ranges (RFC 1918 + link-local)
    const parts = hostname.split(".").map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      const [a, b] = parts;
      if (a === 10) return true;
      if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 127) return true;   // Full 127.0.0.0/8 range
      if (a === 0) return true;
    }

    return false;
  } catch {
    return true; // Invalid URLs are blocked
  }
}

interface WebhookServiceDeps {
  repository: WebhooksRepository;
}

export class WebhookService {
  private readonly repo: WebhooksRepository;

  constructor(private deps: WebhookServiceDeps) {
    this.repo = deps.repository;
  }

  async createEndpoint(
    input: {
      url: string;
      secret: string;
      events: string[];
      metadata?: Record<string, unknown>;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<WebhookEndpoint>> {
    if (isPrivateUrl(input.url)) {
      return Err(
        new CommerceValidationError(
          "Webhook URL must not point to a private or internal address.",
        ),
      );
    }

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);

    const endpoint = await this.repo.createEndpoint(
      {
        organizationId: orgId,
        url: input.url,
        secret: input.secret,
        events: input.events,
        isActive: true,
        metadata: input.metadata ?? {},
      },
      ctx,
    );
    return Ok(endpoint);
  }

  async listEndpoints(
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<WebhookEndpoint[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const endpoints = await this.repo.findAllEndpoints(orgId, ctx);
    return Ok(endpoints);
  }

  async deleteEndpoint(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.repo.findEndpointById(id, orgId, ctx);
    if (!existing) {
      return Err(new CommerceNotFoundError("Webhook endpoint not found."));
    }

    await this.repo.deleteEndpoint(id, ctx);
    return Ok(undefined);
  }

  async getEndpointsForEvent(
    eventName: string,
    orgId: string,
    ctx?: TxContext,
  ): Promise<Result<WebhookEndpoint[]>> {
    const endpoints = await this.repo.findEndpointsForEvent(eventName, orgId, ctx);
    return Ok(endpoints);
  }
}
