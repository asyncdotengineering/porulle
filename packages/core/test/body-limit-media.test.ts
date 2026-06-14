/**
 * Configurable body limit / media upload exemption (#21)
 *
 * The global 1MB body limit blocked product image uploads (phone photos are
 * 3–8MB). POST /api/media/upload is now exempt from the global limit and has
 * its own configurable limit (config.media.maxUploadSize, default 10MB).
 */

import { describe, it, expect } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

const MB = 1024 * 1024;

describe("body limit / media upload exemption (#21)", () => {
  it("media upload above 1MB is NOT rejected by the global limit", async () => {
    const { app } = await createServer(await createTestConfig({ media: { maxUploadSize: 4 * MB } }));
    const res = await app.request("http://localhost/api/media/upload", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "x".repeat(2 * MB),
    });
    // 2MB > 1MB global but < 4MB media limit → passes the size gate
    // (auth/validation then handles it), so it must NOT be a 413.
    expect(res.status).not.toBe(413);
  });

  it("media upload above the media limit returns 413 FILE_TOO_LARGE", async () => {
    const { app } = await createServer(await createTestConfig({ media: { maxUploadSize: 4 * MB } }));
    const res = await app.request("http://localhost/api/media/upload", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "x".repeat(5 * MB),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("a non-media route above 1MB is still rejected by the global limit", async () => {
    const { app } = await createServer(await createTestConfig());
    const res = await app.request("http://localhost/api/catalog/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2 * MB),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
