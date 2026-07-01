import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #35 — GET /catalog/entities/{id}?include=media always returned [].
// Hydration is now backed by a real media/entity link lookup.
describe("Issue #35 — catalog ?include=media hydration", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  let entityId: string;

  // Minimal valid PNG signature so the media service's mime sniffing accepts it.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const create = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `media-${Date.now()}`, metadata: { title: "M" } },
      actor: testActor,
    });
    entityId = (await parseJsonResponse<{ data: { id: string } }>(create)).data.id;
  });

  async function uploadAndAttach(role = "primary"): Promise<string> {
    const uploaded = await kernel.services.media.upload(
      { filename: "pic.png", contentType: "image/png", data: png.buffer },
      testActor,
    );
    expect(uploaded.ok).toBe(true);
    const assetId = uploaded.value.id;
    const attached = await kernel.services.media.attachToEntity(
      { entityId, mediaAssetId: assetId, role },
      testActor,
    );
    expect(attached.ok).toBe(true);
    return assetId;
  }

  it("exposes attached media (with role and url) via ?include=media", async () => {
    const assetId = await uploadAndAttach("primary");

    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}?include=media`,
      actor: testActor,
    });
    const json = await parseJsonResponse<{
      data: { media: Array<{ mediaAssetId: string; role: string; url: string; sortOrder: number }> };
    }>(res);

    expect(json.data.media).toHaveLength(1);
    const m = json.data.media[0]!;
    expect(m.mediaAssetId).toBe(assetId);
    expect(m.role).toBe("primary");
    expect(typeof m.url).toBe("string");
    expect(m.url.length).toBeGreaterThan(0);
  });

  it("removes the media from hydration once the asset is deleted", async () => {
    const assetId = await uploadAndAttach("primary");
    const del = await kernel.services.media.delete(assetId, testActor);
    expect(del.ok).toBe(true);

    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}?include=media`,
      actor: testActor,
    });
    const json = await parseJsonResponse<{ data: { media: unknown[] } }>(res);
    expect(json.data.media).toHaveLength(0);
  });
});
