import { resolveOrgIdForCommerce } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import { CommerceNotFoundError, CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { WebhooksRepository, WebhookEndpoint } from "./repository/index.js";
import { isPrivateUrl } from "./ssrf-guard.js";

interface WebhookServiceDeps {
  repository: WebhooksRepository;
  config: CommerceConfig;
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

    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);

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
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    const endpoints = await this.repo.findAllEndpoints(orgId, ctx);
    return Ok(endpoints);
  }

  async deleteEndpoint(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
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
