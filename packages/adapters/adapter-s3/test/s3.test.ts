import { describe, expect, it } from "vitest";
import { s3StorageAdapter } from "../src/index.js";

describe("adapter-s3", () => {
  it("uploads, lists, signs, and deletes objects", async () => {
    const commands: any[] = [];

    const adapter = s3StorageAdapter({
      bucket: "bucket-1",
      region: "us-east-1",
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      client: {
        async send(command) {
          commands.push(command);
          const name = command?.constructor?.name;

          if (name === "ListObjectsV2Command") {
            return {
              Contents: [
                { Key: "catalog/a.jpg", Size: 11 },
                { Key: "catalog/b.jpg", Size: 22 },
              ],
            };
          }

          return {};
        },
      },
      signUrl: async () => "https://signed.example.com/file?sig=1",
    });

    const uploaded = await adapter.upload(
      "catalog/a.jpg",
      new TextEncoder().encode("payload").buffer,
      "image/jpeg",
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    expect(uploaded.value.url).toContain("/bucket-1/catalog/a.jpg");

    const publicUrl = await adapter.getUrl("catalog/a.jpg");
    expect(publicUrl.ok).toBe(true);
    if (!publicUrl.ok) return;
    expect(publicUrl.value).toContain("/bucket-1/catalog/a.jpg");

    const signed = await adapter.getSignedUrl("catalog/a.jpg", 3600);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value).toContain("signed.example.com");

    const listed = await adapter.list("catalog/");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);

    const deleted = await adapter.delete("catalog/a.jpg");
    expect(deleted.ok).toBe(true);

    const commandNames = commands.map((command) => command?.constructor?.name);
    expect(commandNames).toContain("PutObjectCommand");
    expect(commandNames).toContain("ListObjectsV2Command");
    expect(commandNames).toContain("DeleteObjectCommand");
  });
});
