import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { HookRegistry } from "../src/kernel/hooks/registry.js";
import type { ModuleDeps } from "../src/kernel/module/index.js";
import { Ok } from "../src/kernel/result.js";
import type { AuditService } from "../src/modules/audit/service.js";
import { auditModule } from "../src/modules/audit/index.js";
import type { StorageAdapter } from "../src/modules/media/adapter.js";
import { mediaModule } from "../src/modules/media/index.js";
import { MediaService } from "../src/modules/media/service.js";
import { OrganizationService } from "../src/modules/organization/service.js";
import { organizationModule } from "../src/modules/organization/index.js";
import { WebhookService } from "../src/modules/webhooks/service.js";
import { webhooksModule } from "../src/modules/webhooks/index.js";

function mockStorage(): StorageAdapter {
  return {
    providerId: "test",
    async upload(key, data, contentType) {
      return Ok({
        key,
        url: `http://localhost/${key}`,
        contentType,
        size:
          data instanceof ArrayBuffer
            ? data.byteLength
            : await new Response(data).arrayBuffer().then((b) => b.byteLength),
      });
    },
    async getUrl(key) {
      return Ok(`http://localhost/${key}`);
    },
    async getSignedUrl(key, expiresIn) {
      return Ok(`http://localhost/${key}?e=${expiresIn}`);
    },
    async delete() {
      return Ok(undefined);
    },
    async list() {
      return Ok([]);
    },
  };
}

function tier0Deps(): ModuleDeps {
  const adapter: DatabaseAdapter = {
    provider: "test",
    db: {} as DrizzleDatabase,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  return {
    db: adapter,
    hooks: new HookRegistry(),
    services: {},
    config: { storage: mockStorage() },
    logger,
  };
}

function acceptAudit(s: AuditService) {
  return s;
}

describe("tier-0 defineModule", () => {
  it("auditModule id and service type", () => {
    expect(auditModule.id).toBe("audit");
    const svc = auditModule.service(tier0Deps());
    acceptAudit(svc);
  });

  it("webhooksModule id and service type", () => {
    expect(webhooksModule.id).toBe("webhooks");
    const svc = webhooksModule.service(tier0Deps());
    acceptWebhook(svc);
    expect(svc).toBeInstanceOf(WebhookService);
  });

  it("mediaModule id and service type", () => {
    expect(mediaModule.id).toBe("media");
    const svc = mediaModule.service(tier0Deps());
    acceptMedia(svc);
    expect(svc).toBeInstanceOf(MediaService);
  });

  it("organizationModule id and service type", () => {
    expect(organizationModule.id).toBe("organization");
    const svc = organizationModule.service(tier0Deps());
    acceptOrganization(svc);
    expect(svc).toBeInstanceOf(OrganizationService);
  });
});

function acceptWebhook(s: WebhookService) {
  return s;
}

function acceptMedia(s: MediaService) {
  return s;
}

function acceptOrganization(s: OrganizationService) {
  return s;
}
