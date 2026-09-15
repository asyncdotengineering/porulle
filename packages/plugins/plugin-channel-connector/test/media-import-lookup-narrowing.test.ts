/**
 * `applyMedia` must not load the whole organization's media for every product. One narrowed
 * `media_assets` query per product, keyed to this product's channel image identifiers only.
 *
 * ## Sabotaging this row needs the raised timeout below, and that is the point of it
 *
 * Restoring the unnarrowed `where` makes the import quadratic, and at vitest's default 30 s the
 * run dies of `Test timed out in 30000ms` BEFORE the assertion is ever evaluated. That red looks
 * like a passing sabotage and is not one: a gate with a precondition — or a clock — in front of
 * its assertion can go red for the precondition, and "it went red" is not the claim "the row
 * fired". Observed 2026-09-15 doing exactly that. With the timeout raised the row speaks for
 * itself: `expected 52 to be less than 50`, which is 50 unrelated assets plus the two per-upload
 * reads. The green path takes a few seconds, so the allowance costs nothing when it passes.
 */
import { describe, expect, it } from "vitest";
import {
  createSystemActor,
  type ChannelCatalogItem,
  type PluginDb,
  type Result,
  type StorageAdapter,
} from "@porulle/core";
import { mediaAssets } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const IMAGE_HOST = "https://images.lookup-narrowing.test";
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function memoryStorage(): StorageAdapter {
  return {
    providerId: "memory",
    async upload(key, data, contentType): Promise<Result<{ key: string; url: string; contentType: string; size?: number }>> {
      const body = data instanceof ArrayBuffer ? data : await new Response(data as ReadableStream).arrayBuffer();
      return { ok: true, value: { key, url: `memory://${key}`, contentType, size: body.byteLength } };
    },
    async getUrl(key) { return { ok: true, value: `memory://${key}` }; },
    async getSignedUrl(key) { return { ok: true, value: `memory://${key}` }; },
    async delete() { return { ok: true, value: undefined }; },
    async list() { return { ok: true, value: [] }; },
  } as StorageAdapter;
}

function wrapThenable<T extends object>(value: T, onRows: (rows: unknown[]) => unknown[]): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      const resolved = Reflect.get(target, property, receiver);
      if (property === "then" && typeof resolved === "function") {
        return (onFulfilled?: (rows: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
          Promise.resolve(target).then(
            (rows) => (onFulfilled ? onFulfilled(onRows(rows as unknown[])) : onRows(rows as unknown[])),
            onRejected,
          );
      }
      if (typeof resolved === "function") {
        return (...args: unknown[]) => {
          const next = resolved.apply(target, args);
          if (next && typeof next === "object") return wrapThenable(next as object, onRows);
          return next;
        };
      }
      return resolved;
    },
  }) as T;
}

/**
 * Wraps the service's db handle so every `select().from(mediaAssets)` reports how many rows came back.
 */
function mediaAssetRowCountingDb(db: PluginDb) {
  const counter = { mediaAssetRowsRead: 0 };
  const wrapped = new Proxy(db as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "select" && typeof value === "function") {
        return (...selectArgs: unknown[]) => {
          const builder = (value as (...args: unknown[]) => object).apply(target, selectArgs);
          return new Proxy(builder, {
            get(builderTarget, builderProperty, builderReceiver) {
              const builderValue = Reflect.get(builderTarget, builderProperty, builderReceiver);
              if (builderProperty === "from" && typeof builderValue === "function") {
                return (table: unknown, ...rest: unknown[]) => {
                  const fromBuilder = (builderValue as (...args: unknown[]) => object).apply(builderTarget, [table, ...rest]);
                  if (table !== mediaAssets) return fromBuilder;
                  return wrapThenable(fromBuilder, (rows) => {
                    counter.mediaAssetRowsRead += rows.length;
                    return rows;
                  });
                };
              }
              return typeof builderValue === "function"
                ? (builderValue as (...args: unknown[]) => unknown).bind(builderTarget)
                : builderValue;
            },
          });
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as PluginDb;
  return { db: wrapped, counter };
}

async function seedUnrelatedMediaAssets(db: PluginDb, count: number) {
  await db.insert(mediaAssets).values(
    Array.from({ length: count }, (_, index) => ({
      organizationId: TEST_ORG_ID,
      storageKey: `unrelated/${index}.png`,
      filename: `unrelated-${index}.png`,
      contentType: "image/png",
      size: PNG.byteLength,
      metadata: {
        channelImageExternalId: `unrelated-external-${index}`,
        channelImageUrlHash: `unrelated-hash-${index}`,
      },
      origin: "merchant" as const,
    })),
  );
}

async function importProductWithImages(
  unrelatedAssetCount: number,
  imageCount: number,
): Promise<{ mediaAssetRowsRead: number; unrelatedAssetCount: number }> {
  const externalId = `lookup-narrowing-${crypto.randomUUID()}`;
  const item: ChannelCatalogItem = {
    externalId,
    slug: externalId,
    title: "Lookup narrowing probe",
    status: "active",
    attributes: [{ locale: "en", title: "Lookup narrowing probe" }],
    variants: [],
    images: Array.from({ length: imageCount }, (_, index) => ({
      url: `${IMAGE_HOST}/${externalId}/${index}.png`,
      externalId: `${externalId}-image-${index}`,
      role: index === 0 ? ("primary" as const) : ("gallery" as const),
      sortOrder: index,
    })),
  };
  const connector = mockChannelConnector({ catalog: [item] });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }), {
    storage: memoryStorage(),
  });
  await seedUnrelatedMediaAssets(built.db, unrelatedAssetCount);
  const { db: counted, counter } = mediaAssetRowCountingDb(built.db);
  const service = new ChannelConnectorService(counted, built.kernel.services, { connectors: [connector] });
  const storeResponse = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${externalId}.test` }),
  });
  expect(storeResponse.status).toBe(201);
  const storeId = (await storeResponse.json()).data.id as string;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(IMAGE_HOST)) {
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return originalFetch(input as RequestInfo);
  }) as typeof fetch;
  try {
    const imported = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(imported).toMatchObject({ ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  return { mediaAssetRowsRead: counter.mediaAssetRowsRead, unrelatedAssetCount };
}

describe("applyMedia narrows the per-product media_assets lookup", () => {
  it("does not read unrelated media_assets rows in proportion to how many the org already holds", async () => {
    const smallOrg = await importProductWithImages(50, 2);
    const largeOrg = await importProductWithImages(200, 2);

    expect(
      smallOrg.mediaAssetRowsRead,
      "an unnarrowed org-wide select would return at least every unrelated asset — 50 here",
    ).toBeLessThan(smallOrg.unrelatedAssetCount);
    expect(
      largeOrg.mediaAssetRowsRead,
      "row count must not grow with unrelated assets — an unnarrowed org-wide select would read 200 here",
    ).toBeLessThan(largeOrg.unrelatedAssetCount);
    expect(largeOrg.mediaAssetRowsRead).toBe(smallOrg.mediaAssetRowsRead);
  }, 180_000);
});
