import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

// Issue #34 — the global csrf() rejected bodyless API-key server-to-server
// POSTs (no Origin, no JSON content-type) with a masked 403 "Request rejected."
// CSRF is now skipped for API-key requests, and genuine CSRF rejections carry a
// distinguishable CSRF_ORIGIN_REJECTED code.
describe("Issue #34 — CSRF vs API-key requests", () => {
  let app: any;
  const target = "http://localhost/api/catalog/entities/00000000-0000-4000-8000-000000000001/publish";

  beforeAll(async () => {
    const config = await createTestConfig();
    const server = await createServer(config);
    app = server.app;
  });

  it("blocks a bodyless browser-style POST (no Origin, no key) with a distinguishable CSRF code", async () => {
    const res = await app.request(target, { method: "POST" });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("CSRF_ORIGIN_REJECTED");
  });

  it("does NOT CSRF-reject a bodyless POST carrying an x-api-key", async () => {
    const res = await app.request(target, {
      method: "POST",
      headers: { "x-api-key": "test-key-not-valid" },
    });
    const json = await res.json().catch(() => ({}));
    // The request gets past CSRF and is handled by auth/permissions instead
    // (401/403-permission/404) — never the CSRF guard.
    expect(json.error?.code).not.toBe("CSRF_ORIGIN_REJECTED");
  });

  it("does NOT CSRF-reject a bodyless POST carrying a bearer token", async () => {
    const res = await app.request(target, {
      method: "POST",
      headers: { authorization: "Bearer some-token" },
    });
    const json = await res.json().catch(() => ({}));
    expect(json.error?.code).not.toBe("CSRF_ORIGIN_REJECTED");
  });
});
