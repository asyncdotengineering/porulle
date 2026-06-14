/**
 * No-op storage default (#27)
 *
 * defineConfig no longer hard-requires storage: with none configured it
 * defaults to a built-in no-op adapter so catalog-only deployments boot.
 * getUrl passes through; mutating media ops report STORAGE_NOT_SUPPORTED;
 * the upload route answers 501 under the no-op default.
 */

import { describe, it, expect } from "vitest";
import { defineConfig } from "../src/config/define-config.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestServer } from "../src/test-utils/rest-api-test-utils.js";
import { noopStorageAdapter } from "../src/index.js";
import type { Actor } from "../src/auth/types.js";

const adminActor: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-0000000000ad",
  email: null,
  name: "Admin",
  vendorId: null,
  organizationId: "org_default",
  role: "owner",
  permissions: ["*:*"],
};

describe("no-op storage default (#27)", () => {
  it("defineConfig defaults storage to the no-op adapter and the kernel boots", async () => {
    const { adapter } = await createPGliteTestAdapter();
    const config = await defineConfig({
      database: { provider: "postgresql" },
      databaseAdapter: adapter,
    });
    expect(config.storage?.providerId).toBe("noop");
    expect(() => createKernel(config)).not.toThrow();
  });

  it("noopStorageAdapter: getUrl passes through; mutating ops are unsupported", async () => {
    const url = await noopStorageAdapter.getUrl("some/key");
    expect(url.ok).toBe(true);
    if (url.ok) expect(url.value).toBe("some/key");

    const up = await noopStorageAdapter.upload("k", new ArrayBuffer(1), "image/png");
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.error.code).toBe("STORAGE_NOT_SUPPORTED");

    expect((await noopStorageAdapter.list("")).ok).toBe(true);
    expect((await noopStorageAdapter.delete("k")).ok).toBe(true);
  });

  it("POST /api/media/upload returns 501 storage_not_supported under the no-op default", async () => {
    const { server, cleanup } = await createTestServer({ storage: noopStorageAdapter });
    try {
      const form = new FormData();
      form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
      const res = await server.request("/api/media/upload", {
        method: "POST",
        headers: { "x-test-actor": JSON.stringify(adminActor) },
        body: form,
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("storage_not_supported");
    } finally {
      await cleanup();
    }
  });
});
