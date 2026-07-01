import { afterAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createServer } from "../src/runtime/server.js";
import { requirePerm } from "../src/interfaces/rest/utils.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

// Ordereka field study: `config.routes(app, kernel)` excluded the Better Auth
// instance, forcing integrators into module-global holder shims to mint
// per-shift API keys (apps/api/src/runtime/auth-holder.ts). The routes
// callback now receives `auth` as its third argument, and requirePerm is a
// public export so custom routes can authorize without duplicating role maps.
describe("config.routes(app, kernel, auth) + public requirePerm", () => {
  let cleanup: () => Promise<void>;

  afterAll(async () => {
    await cleanup?.();
  });

  it("passes the Better Auth instance into the routes callback and wires requirePerm", async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({});
    cleanup = c;

    let capturedAuth: unknown;
    const { app } = await createServer({
      ...config,
      routes: (app: Hono<any>, _kernel, auth) => {
        capturedAuth = auth;
        app.get(
          "/api/custom/ping",
          requirePerm("custom:read") as never,
          (c) => c.json({ data: "pong" }),
        );
      },
    });

    // The auth instance arrived — integrators can call auth.api.* directly
    expect(capturedAuth).toBeDefined();
    expect(typeof (capturedAuth as { api?: unknown }).api).toBe("object");

    // requirePerm participates in the real middleware stack: no actor → 401
    const res = await app.request("http://localhost/api/custom/ping");
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
