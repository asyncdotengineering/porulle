import { describe, expect, it, vi } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import type { SearchAdapter } from "../src/modules/search/adapter.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

function noOpSearchAdapter(): SearchAdapter {
  return {
    providerId: "test-search",
    async index() {
      return { ok: true, value: undefined };
    },
    async remove() {
      return { ok: true, value: undefined };
    },
    async search() {
      return {
        ok: true,
        value: { hits: [], total: 0, page: 1, limit: 20, facets: {} },
      };
    },
    async suggest() {
      return { ok: true, value: [] };
    },
  };
}

describe("search adapter initialization", () => {
  it("passes the configured database to an adapter init hook", async () => {
    const init = vi.fn();
    const adapter: SearchAdapter = { ...noOpSearchAdapter(), init };
    const { config, cleanup } = await createPGliteTestConfig({
      search: { adapter },
    });

    try {
      const kernel = createKernel(config);

      expect(init).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledWith({ db: kernel.database.db });
    } finally {
      await cleanup();
    }
  });

  it("still wires an adapter that does not define init", async () => {
    const adapter = noOpSearchAdapter();
    const { config, cleanup } = await createPGliteTestConfig({
      search: { adapter },
    });

    try {
      expect(createKernel(config).services.search).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});
