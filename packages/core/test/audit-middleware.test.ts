/**
 * auditMiddleware (#16)
 *
 * Writes exactly one commerce_audit_log row per successful (2xx) mutation,
 * with sensible derived defaults and handler overrides. GETs and failed
 * requests write nothing; audit-write failures never affect the response.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { ensureDefaultOrg } from "../src/auth/org.js";
import { auditMiddleware } from "../src/index.js";
import type { Actor } from "../src/auth/types.js";

const actor: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-0000000000aa",
  email: null,
  name: "Tester",
  vendorId: null,
  organizationId: "org_default",
  role: "owner",
  permissions: ["*:*"],
};

describe("auditMiddleware (#16)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let app: Hono;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await createPGliteTestConfig();
    cleanup = built.cleanup;
    kernel = createKernel(built.config);
    await ensureDefaultOrg(kernel.database.db);

    app = new Hono();
    app.use("*", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("actor", actor);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("requestId", "req-test");
      await next();
    });
    app.use("*", auditMiddleware(kernel));
    app.post("/api/widgets", (c) => c.json({ data: { id: "w-123" } }, 201));
    app.get("/api/widgets", (c) => c.json({ data: [] }));
    app.post("/api/explode", (c) => c.json({ error: { code: "X", message: "boom" } }, 400));
    app.post("/api/custom", (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("auditEvent", "refund.manager_override");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("auditEntityType", "order");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("auditEntityId", "o-9");
      return c.json({ data: { ok: true } }, 200);
    });
  });

  afterEach(async () => {
    await cleanup?.();
  });

  it("writes one row for a 2xx POST with derived event + data.id entityId", async () => {
    const res = await app.request("/api/widgets", { method: "POST" });
    expect(res.status).toBe(201);

    const rows = await kernel.services.audit.list({ limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "post:/api/widgets",
      entityType: "widgets",
      entityId: "w-123",
    });
  });

  it("does not write for GET requests", async () => {
    await app.request("/api/widgets");
    expect(await kernel.services.audit.list({ limit: 50 })).toHaveLength(0);
  });

  it("does not write for non-2xx responses", async () => {
    const res = await app.request("/api/explode", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await kernel.services.audit.list({ limit: 50 })).toHaveLength(0);
  });

  it("honors handler overrides for event / entityType / entityId", async () => {
    await app.request("/api/custom", { method: "POST" });
    const rows = await kernel.services.audit.list({ limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "refund.manager_override",
      entityType: "order",
      entityId: "o-9",
    });
  });
});
