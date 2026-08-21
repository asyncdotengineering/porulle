import { describe, expect, it } from "vitest";
import type {
  SearchAdapter,
  SearchDocument,
  SearchQueryParams,
  SearchSuggestParams,
} from "../src/modules/search/adapter.js";
import type { Actor } from "../src/auth/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const admin = (organizationId: string): Actor => ({
  type: "user",
  userId: `round2-search-admin-${organizationId}`,
  email: `${organizationId}@round2.test`,
  name: "Round 2 Search Admin",
  vendorId: null,
  organizationId,
  role: "admin",
  permissions: ["*:*"],
});

const editorA: Actor = {
  ...admin("org_round2_search_a"),
  role: "staff",
  permissions: ["catalog:read", "catalog:update"],
};

describe("round 2 search adapter tenancy", () => {
  it("filters adapter hits and facets to the requesting organization", async () => {
    const indexed: SearchDocument[] = [];
    const adapter: SearchAdapter = {
      providerId: "round2-shared-index",
      async index(documents) {
        indexed.push(...documents);
        return { ok: true, value: undefined };
      },
      async remove() {
        return { ok: true, value: undefined };
      },
      async search(params: SearchQueryParams) {
        const tokens = params.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = indexed.filter((document) => tokens.every((token) => document.text.toLowerCase().includes(token)));
        return {
          ok: true,
          value: {
            hits: matches.map((document) => ({ id: document.id, score: 1, document })),
            total: matches.length,
            page: 1,
            limit: params.limit ?? 20,
            facets: { type: { product: indexed.length } },
          },
        };
      },
      async suggest(_params: SearchSuggestParams) {
        return { ok: true, value: indexed.map((document) => document.title) };
      },
    };

    const { config, cleanup } = await createPGliteTestConfig({ search: { adapter } });
    try {
      const kernel = createKernel(config);
      await kernel.services.organization.create({ id: "org_round2_search_a", name: "Search A", slug: "round2-search-a" });
      await kernel.services.organization.create({ id: "org_round2_search_b", name: "Search B", slug: "round2-search-b" });
      const a = await kernel.services.catalog.create(
        { type: "product", slug: "round2-a", status: "active", attributes: { title: "Round 2 A Product" } },
        admin("org_round2_search_a"),
      );
      const bActive = await kernel.services.catalog.create(
        { type: "product", slug: "round2-b-active", status: "active", attributes: { title: "Round 2 Rival Active" }, metadata: { secret: "B_ACTIVE" } },
        admin("org_round2_search_b"),
      );
      const bDraft = await kernel.services.catalog.create(
        { type: "product", slug: "round2-b-draft", status: "draft", attributes: { title: "Round 2 Rival Draft" }, metadata: { secret: "B_DRAFT" } },
        admin("org_round2_search_b"),
      );
      expect(a.ok && bActive.ok && bDraft.ok).toBe(true);

      const storefront = await kernel.services.search.query(
        { query: "Round 2", facets: ["type"] },
        { actor: { ...editorA, role: "customer", permissions: ["catalog:read"] }, tx: null, requestId: "round2-storefront" },
      );
      expect(storefront.ok).toBe(true);
      if (!storefront.ok) throw storefront.error;
      expect(storefront.value.hits.map((hit) => hit.document.slug)).toEqual(["round2-a"]);
      expect(storefront.value.facets.type).toEqual({ product: 1 });

      const editor = await kernel.services.search.query(
        { query: "Rival" },
        { actor: editorA, tx: null, requestId: "round2-editor" },
      );
      expect(editor.ok).toBe(true);
      if (!editor.ok) throw editor.error;
      expect(editor.value.hits).toHaveLength(0);
      expect(JSON.stringify(editor.value)).not.toContain("B_DRAFT");
    } finally {
      await cleanup();
    }
  });
});
