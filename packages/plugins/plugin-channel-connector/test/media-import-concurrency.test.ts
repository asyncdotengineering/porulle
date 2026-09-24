/**
 * The images of one product are independent of each other, and `applyMedia` downloaded and
 * re-uploaded them one at a time.
 *
 * Measured on the deployed Worker: an import costs ~10 s per product and ~7.4 s of that is image
 * handling — two external round trips per image, carrying the whole payload, inside a loop that is
 * itself serial. gflock-100 carries 448 images across 100 products, so a product pays roughly
 * 4.5 x (download + upload) at about 1.6 s an image.
 *
 * The bound is not a taste preference. A Cloudflare Worker may hold at most SIX simultaneous
 * outbound connections per invocation, and one image costs TWO of them (the download and the
 * storage put), so three images may be in flight and a fourth would queue behind the limit rather
 * than go faster. The test asserts BOTH ends: serial is a defect, and exceeding the budget is a
 * different defect that would show up as stalls under a real catalog rather than here.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type Result, type StorageAdapter } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { mediaAssets } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const IMAGE_HOST = "https://images.concurrency.test";
/** A one-pixel PNG. The magic bytes matter: the media service sniffs them and refuses a payload
 *  whose declared content type disagrees, so a stub returning zeroes would fail for the wrong
 *  reason and every row below would pass or fail on a mime error rather than on concurrency. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function memoryStorage(): StorageAdapter {
  const objects = new Map<string, number>();
  return {
    providerId: "memory",
    async upload(key, data, contentType): Promise<Result<{ key: string; url: string; contentType: string; size?: number }>> {
      const body = data instanceof ArrayBuffer ? data : await new Response(data as ReadableStream).arrayBuffer();
      objects.set(key, body.byteLength);
      return { ok: true, value: { key, url: `memory://${key}`, contentType, size: body.byteLength } };
    },
    async getUrl(key) { return { ok: true, value: `memory://${key}` }; },
    async getSignedUrl(key) { return { ok: true, value: `memory://${key}` }; },
    async delete(key) { objects.delete(key); return { ok: true, value: undefined }; },
    async list() { return { ok: true, value: [] }; },
  } as StorageAdapter;
}

/**
 * Replaces fetch for the image host only, recording how many downloads are open at once.
 * Everything else is delegated, so a kernel that fetches something unrelated is not broken by this.
 */
function recordingImageFetch(delayMs: number) {
  const original = globalThis.fetch;
  const state = { peak: 0, open: 0, calls: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(IMAGE_HOST)) return original(input as RequestInfo, init);
    state.calls += 1;
    state.open += 1;
    state.peak = Math.max(state.peak, state.open);
    try {
      await new Promise((resume) => setTimeout(resume, delayMs));
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    } finally {
      state.open -= 1;
    }
  }) as typeof fetch;
  return { state, restore: () => { globalThis.fetch = original; } };
}

async function importOneProductWithImages(imageCount: number, delayMs: number, duplicateOfIndex?: number) {
  const externalId = `media-concurrency-${crypto.randomUUID()}`;
  const item: ChannelCatalogItem = {
    externalId,
    slug: externalId,
    title: "Six angles of the same dress",
    status: "active",
    attributes: [{ locale: "en", title: "Six angles of the same dress" }],
    // One variant per image, each image its variant's first photo: the import ruling
    // (`selectImportImages`, used by this path since 0.57.1) keeps the hero plus the first photo of
    // each other variant, so this is a product whose every image is imported — six colourways.
    variants: Array.from({ length: imageCount }, (_, index) => ({ externalId: `${externalId}-v${index}`, sku: `${externalId}-sku-${index}` })),
    images: Array.from({ length: imageCount }, (_, index) => {
      // `duplicateOfIndex` makes the LAST image a second reference to an earlier one — the same
      // url and the same externalId. A product whose feed lists one photo twice is ordinary.
      const source = duplicateOfIndex !== undefined && index === imageCount - 1 ? duplicateOfIndex : index;
      return {
        url: `${IMAGE_HOST}/${externalId}/${source}.png`,
        externalId: `${externalId}-image-${source}`,
        role: index === 0 ? ("primary" as const) : ("gallery" as const),
        sortOrder: index,
        variantExternalIds: [`${externalId}-v${index}`],
      };
    }),
  };
  const connector = mockChannelConnector({ catalog: [item] });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }), {
    storage: memoryStorage(),
  });
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const storeResponse = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${externalId}.test` }),
  });
  expect(storeResponse.status).toBe(201);
  const storeId = (await storeResponse.json()).data.id as string;

  const recorder = recordingImageFetch(delayMs);
  try {
    // backfillCatalog rather than importCatalog: the three-argument importCatalog answers
    // `{ imported, cursor }` and drops the media tally, and `mediaImported` is the number a
    // double count would corrupt.
    const imported = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(imported).toMatchObject({ ok: true });
    return { built, peak: recorder.state.peak, calls: recorder.state.calls, result: imported };
  } finally {
    recorder.restore();
  }
}

describe("applyMedia downloads the images of one product concurrently, within the Worker's connection budget", () => {
  it("holds more than one image download open at a time", async () => {
    const { built, peak, calls } = await importOneProductWithImages(6, 40);

    // The positive twin: without this the row is satisfied by an import that fetched nothing at all.
    expect(calls).toBe(6);
    const assets = await built.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, TEST_ORG_ID));
    expect(assets).toHaveLength(6);

    expect(peak).toBeGreaterThan(1);
  });

  it("counts one upload once when a product lists the same image twice", async () => {
    // Serially, the second reference found the asset the first had just pushed into `assets` and
    // imported nothing. Concurrently the two must share ONE in-flight upload — and sharing it must
    // not mean sharing its tally. A deduped image that returns the first one's result object
    // reports `imported` twice for one stored object, which is a count the caller acts on.
    // Three images with the LAST a second reference to index 1. Since 0.57.1 the import ruling
    // (`selectImportImages`) drops a repeated url before anything is downloaded, so the in-flight
    // sharing is no longer what saves this case — but the claim is the same and still checked: one
    // stored object is fetched once and counted once.
    const { built, calls, result } = await importOneProductWithImages(3, 40, 1);

    expect(calls).toBe(2);
    const assets = await built.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, TEST_ORG_ID));
    expect(assets).toHaveLength(2);

    // The number the caller acts on. Two stored objects reported as three is a lie about what an
    // import did, and sharing one upload must not mean sharing its tally.
    expect((result as { value: { mediaImported: number } }).value.mediaImported).toBe(2);
  });

  it("reaches exactly three open downloads and never a fourth — six subrequests, the Worker's whole budget", async () => {
    const { peak, calls } = await importOneProductWithImages(9, 60);
    expect(calls).toBe(9);

    // Both ends in one row, deliberately. `<= 3` alone is satisfied by a serial loop, so a run that
    // never parallelised at all would be indistinguishable from a correctly bounded one — and the
    // deployed per-product number would then be quoted as evidence of a bound that was never
    // reached. `=== 3` says the pool filled AND that a fourth connection was never opened.
    expect(peak).toBe(3);
  });
});
