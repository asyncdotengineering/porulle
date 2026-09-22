import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "@porulle/core/drizzle";
import type { ChannelCatalogItem, StorageAdapter } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelEntityMap } from "../src/schema.js";
import { variants } from "@porulle/core/schema";
import { connectedStores } from "../src/schema.js";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

/**
 * A VARIANT-kind mapping row with a null `variantId` is a broken invariant, and the importer used to
 * make it worse.
 *
 * `variantId` is nullable for a good reason — `channel_entity_map` also holds `kind: "entity"` rows,
 * which have no variant. But a variant row with none satisfies `!variantId`, so the converge loop
 * took the create branch, minted a SECOND variant, and then inserted a mapping whose
 * (store, kind, externalId) tuple was already taken by the broken row — raising
 * `channel_entity_map_store_kind_external_unique` and failing the item on every subsequent sync.
 * The row could never heal; each pass created another orphan variant and failed again.
 *
 * The repair is an UPDATE of the row already holding the key. This row is the proof.
 */
const item: ChannelCatalogItem = {
  externalId: "repair-1",
  slug: "repair-1",
  title: "Repair Product",
  description: "d",
  status: "active",
  variants: [
    { externalId: "rv-1", sku: "RV-1", prices: [{ currency: "USD", amount: 1000 }] },
  ],
};

describe("a variant mapping with a null variantId is repaired, not duplicated", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storeId: string;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeAll(async () => {
    const storage = {
      providerId: "repair-storage",
      async upload(key: string, _d: ArrayBuffer, contentType: string) {
        return { ok: true as const, value: { key, url: `https://s.test/${key}`, contentType, size: 1 } };
      },
      async getUrl(key: string) { return { ok: true as const, value: `https://s.test/${key}` }; },
      async delete() { return { ok: true as const, value: undefined }; },
    } as unknown as StorageAdapter;
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array([1]).buffer, {
      headers: { "content-type": "image/png" },
    }));
    const mock = mockChannelConnector({ catalog: [item] });
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock] }), { storage });
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [mock] });
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "repair.test", webhookSecret: "s" }),
    });
    expect(response.status).toBe(201);
    storeId = (await response.json()).data.id as string;
  }, 60_000);

  afterAll(() => { fetchSpy.mockRestore(); });

  it("converges the item and leaves exactly one mapping row, now carrying a variantId", async () => {
    // Import once so the entity exists, then BREAK the variant mapping the way a partial failure
    // would: the key stays, the target is gone.
    const first = await service.importCatalog(TEST_ORG_ID, storeId, testAdminActor);
    expect(first.ok).toBe(true);

    await built.db.update(channelEntityMap)
      .set({ variantId: null })
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "variant")));

    const broken = await built.db.select().from(channelEntityMap)
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "variant")));
    expect(broken).toHaveLength(1);
    expect(broken[0]?.variantId).toBeNull();

    // Re-walk from the start. `backfillCatalog` will NOT do this: after a completed import the
    // store's `catalogCursor` is exhausted, so a backfill scans zero items and converges nothing —
    // it reports `complete: true` having done no work at all. Resetting the cursor and clearing the
    // entity's syncHash is what a store actually changing something looks like, and it is the only
    // shape that reaches `upsertVariants`.
    await built.db.update(connectedStores).set({ catalogCursor: null }).where(eq(connectedStores.id, storeId));
    await built.db.update(channelEntityMap).set({ syncHash: "forced-stale" })
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity")));

    const second = await service.importCatalog(TEST_ORG_ID, storeId, testAdminActor);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.failures ?? []).toEqual([]);

    const after = await built.db.select().from(channelEntityMap)
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "variant")));
    // ONE row, not two: the unique key was already occupied, so a second row is the failure mode.
    expect(after).toHaveLength(1);
    expect(after[0]?.variantId).not.toBeNull();
    expect(after[0]?.id).toBe(broken[0]?.id);
  }, 60_000);
});
