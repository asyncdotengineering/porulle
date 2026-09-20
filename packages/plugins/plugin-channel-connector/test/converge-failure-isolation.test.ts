/**
 * One unimportable product must cost one product, not the rest of the catalog.
 *
 * `convergeCatalogItems` used to `return PluginErr` on the first item that failed. In
 * `importCatalog` that return happens BEFORE the `connected_stores.catalogCursor` write, while
 * every item already converged in that batch stays committed. So the retry re-fetched the same
 * page, re-converged the same prefix, and failed on the same item again: a single malformed
 * product halted a merchant's catalog at whatever position it sat in, permanently, and no amount
 * of retrying advanced past it.
 *
 * The trigger here is the realistic one. A slug collision inside the same store is ADOPTED by the
 * orphan branch, so it cannot be used. A collision with an entity the merchant created by hand in
 * Merchant Center is not: that row has no `sourceStoreId`, the orphan lookup filters on the store,
 * and `catalog.create` then rejects the slug on the org-unique index.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);

function product(externalId: string, slug = externalId): ChannelCatalogItem {
  return {
    externalId,
    slug,
    title: `Product ${externalId}`,
    attributes: [{ locale: "en", title: `Product ${externalId}` }],
    variants: [
      {
        externalId: `${externalId}-v1`,
        sku: `${externalId}-v1`,
        prices: [{ amount: 1000, currency: "LKR" }],
        optionValues: { Size: "M" },
      },
    ],
  };
}

describe("a failing item does not halt the batch", () => {
  it("converges the rest of the page, names the failure, and consumes the whole page", async () => {
    const catalog: ChannelCatalogItem[] = [
      product("iso-000"),
      product("iso-001"),
      product("iso-002"),
      product("iso-003"),
      product("iso-004"),
    ];
    const connector = mockChannelConnector({ catalog });
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });

    // A product a person made in Merchant Center, holding the slug the third imported item wants.
    // No sourceStoreId, so the orphan branch cannot adopt it.
    const handMade = await built.kernel.services.catalog.create(
      { type: "product", slug: "iso-002" },
      testAdminActor,
    );
    expect(handMade.ok, "fixture: the colliding entity must exist before the import").toBe(true);

    const created = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "isolation.converge.test" }),
    });
    expect(created.status).toBe(201);
    const storeId = (await created.json()).data.id as string;

    const result = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 5 });

    expect(
      result.ok,
      `one bad item must not fail the import: ${result.ok ? "" : JSON.stringify(result.error)}`,
    ).toBe(true);
    if (!result.ok) return;

    expect(
      result.value.failures,
      "the failure must be surfaced — swallowing it is worse than the halt this replaced",
    ).toEqual([{ externalId: "iso-002", error: expect.stringContaining("iso-002") }]);

    expect(result.value.imported, "the other four products must land").toBe(4);

    const entityRows = (await built.db.select().from(channelEntityMap).where(eq(channelEntityMap.storeId, storeId)))
      .filter((row) => row.kind === "entity");
    expect(entityRows.map((row) => row.externalId).sort()).toEqual(["iso-000", "iso-001", "iso-003", "iso-004"]);

    // The cursor is the halt. The whole page was consumed, so the walk moves on rather than
    // re-fetching the same page and failing on the same item forever.
    expect(result.value.exhausted, "the page was fully consumed, failure included").toBe(true);
    const store = (await built.db.select().from(connectedStores).where(eq(connectedStores.id, storeId)))[0]!;
    expect(store.catalogCursor, "an exhausted catalog clears the cursor").toBeNull();

    // And the failed item left no half-written identity behind.
    const orphaned = await built.db.select().from(sellableEntities).where(eq(sellableEntities.sourceStoreId, storeId));
    expect(orphaned).toHaveLength(4);
  }, 180_000);
});
