import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { localStorageAdapter } from "../src/index.js";

describe("local storage adapter", () => {
  it("uploads, lists and deletes files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-local-storage-"));
    const adapter = localStorageAdapter({
      basePath: dir,
      baseUrl: "http://localhost/assets",
    });

    const upload = await adapter.upload(
      "test/hello.txt",
      new TextEncoder().encode("hello").buffer,
      "text/plain",
    );

    expect(upload.ok).toBe(true);

    const listed = await adapter.list("test");
    expect(listed.ok).toBe(true);

    const deleted = await adapter.delete("test/hello.txt");
    expect(deleted.ok).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  describe("path traversal — regression for HIGH-7 (pi audit)", () => {
    it("rejects upload with .. traversal", async () => {
      const dir = await mkdtemp(join(tmpdir(), "uc-traversal-"));
      const adapter = localStorageAdapter({ basePath: dir, baseUrl: "http://localhost/assets" });
      await expect(
        adapter.upload("../../etc/passwd", new TextEncoder().encode("x").buffer, "text/plain"),
      ).rejects.toThrow(/escapes storage root/);
      await rm(dir, { recursive: true, force: true });
    });

    it("rejects delete with .. traversal", async () => {
      const dir = await mkdtemp(join(tmpdir(), "uc-traversal-"));
      const adapter = localStorageAdapter({ basePath: dir, baseUrl: "http://localhost/assets" });
      await expect(adapter.delete("../../etc/cron.d/evil")).rejects.toThrow(/escapes storage root/);
      await rm(dir, { recursive: true, force: true });
    });

    it("rejects upload with absolute path", async () => {
      const dir = await mkdtemp(join(tmpdir(), "uc-traversal-"));
      const adapter = localStorageAdapter({ basePath: dir, baseUrl: "http://localhost/assets" });
      await expect(
        adapter.upload("/etc/passwd", new TextEncoder().encode("x").buffer, "text/plain"),
      ).rejects.toThrow(/escapes storage root/);
      await rm(dir, { recursive: true, force: true });
    });

    it("rejects upload with NUL byte", async () => {
      const dir = await mkdtemp(join(tmpdir(), "uc-traversal-"));
      const adapter = localStorageAdapter({ basePath: dir, baseUrl: "http://localhost/assets" });
      await expect(
        adapter.upload("safe.txt\0/../../etc/passwd", new TextEncoder().encode("x").buffer, "text/plain"),
      ).rejects.toThrow(/NUL byte/);
      await rm(dir, { recursive: true, force: true });
    });

    it("allows nested keys that stay within basePath", async () => {
      const dir = await mkdtemp(join(tmpdir(), "uc-traversal-"));
      const adapter = localStorageAdapter({ basePath: dir, baseUrl: "http://localhost/assets" });
      const result = await adapter.upload(
        "subdir/nested/file.txt",
        new TextEncoder().encode("ok").buffer,
        "text/plain",
      );
      expect(result.ok).toBe(true);
      await rm(dir, { recursive: true, force: true });
    });
  });
});
