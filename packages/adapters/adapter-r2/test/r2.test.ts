import { describe, expect, it } from "vitest";
import { r2StorageAdapter } from "../src/index.js";

describe("adapter-r2", () => {
  it("uploads, lists, signs, and deletes objects through R2 binding", async () => {
    const objects = new Map<string, { body: ArrayBuffer; contentType: string }>();

    const adapter = r2StorageAdapter({
      bucketName: "assets",
      publicBaseUrl: "https://cdn.example.com",
      bucket: {
        async put(key, value, options) {
          const bytes =
            value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          const body = bytes.slice().buffer;
          objects.set(key, {
            body,
            contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
          });
        },
        async get(key) {
          const entry = objects.get(key);
          if (!entry) return null;
          return {
            async arrayBuffer() {
              return entry.body;
            },
            httpMetadata: {
              contentType: entry.contentType,
            },
          };
        },
        async delete(key) {
          objects.delete(key);
        },
        async list(options) {
          const prefix = options?.prefix ?? "";
          return {
            objects: [...objects.entries()]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, value]) => ({
                key,
                size: value.body.byteLength,
                httpMetadata: {
                  contentType: value.contentType,
                },
              })),
          };
        },
      },
    });

    const uploaded = await adapter.upload(
      "catalog/a.jpg",
      new TextEncoder().encode("hello").buffer,
      "image/jpeg",
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    expect(uploaded.value.url).toBe("https://cdn.example.com/catalog/a.jpg");

    const signed = await adapter.getSignedUrl("catalog/a.jpg", 300);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value).toContain("expiresIn=300");

    const listed = await adapter.list("catalog/");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);

    const deleted = await adapter.delete("catalog/a.jpg");
    expect(deleted.ok).toBe(true);

    const listedAfterDelete = await adapter.list("catalog/");
    expect(listedAfterDelete.ok).toBe(true);
    if (!listedAfterDelete.ok) return;
    expect(listedAfterDelete.value).toHaveLength(0);
  });
});
