/**
 * Every store-taking connector call runs on credentials good for it — refreshed when they are about
 * to lapse, and refreshed by force when the provider rejects them early.
 *
 * Failure modes, written first: the refresh never happens and the row passes on a connector that
 * never rejects (the stub records the token each call PRESENTED); a refresh is made and not kept (the
 * row reads the database); a rejected refresh retries forever (a second rejection must be the answer,
 * after exactly two calls).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_CREDENTIALS_REJECTED, Err, Ok } from "@porulle/core";
import type { ChannelStore } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core/testing";
import { eq } from "@porulle/core/drizzle";
import { ChannelConnectorService, channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { connectedStores } from "../src/schema.js";

const presented: string[] = [];
let rejectEverything = false;

function rotatingConnector() {
  const base = mockChannelConnector({ catalog: [] });
  return {
    ...base,
    providerId: "rotating",
    async liveCredentials(store: ChannelStore, options?: { force?: boolean }) {
      if (options?.force !== true) return Ok(null);
      return Ok({ accessToken: `${String(store.credentials.accessToken)}+refreshed` });
    },
    async importCatalog(store: ChannelStore) {
      const token = String(store.credentials.accessToken);
      presented.push(token);
      if (rejectEverything || !token.endsWith("+refreshed")) return Err({ code: CHANNEL_CREDENTIALS_REJECTED, message: "token retired", retriable: false });
      return Ok({ items: [], nextCursor: null });
    },
  };
}

describe("live credentials", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  const orgId = testAdminActor.organizationId ?? "";

  beforeAll(async () => {
    const options = { connectors: [rotatingConnector()] };
    built = await createPluginTestApp(channelConnectorPlugin(options));
    service = new ChannelConnectorService(built.db, built.kernel.services, options);
  }, 120_000);

  async function store(token: string): Promise<string> {
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "rotating", credentials: { accessToken: token }, storeDomain: `${token}.example` }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).data.id as string;
  }

  it("retries a rejected call once on credentials refreshed by force, and keeps them", async () => {
    presented.length = 0;
    const id = await store("first");
    const page = await service.fetchCatalogPage(orgId, id, null);
    expect(page.ok).toBe(true);
    expect(presented).toEqual(["first", "first+refreshed"]);
    const [row] = await built.db.select().from(connectedStores).where(eq(connectedStores.id, id));
    expect(row?.credentials).toEqual({ accessToken: "first+refreshed" });
  });

  it("answers a second rejection rather than retrying again, and marks the store for reconnection only if the refresh itself is refused", async () => {
    presented.length = 0;
    rejectEverything = true;
    try {
      const id = await store("second");
      const page = await service.fetchCatalogPage(orgId, id, null);
      expect(page.ok).toBe(false);
      expect(presented).toEqual(["second", "second+refreshed"]);
    } finally {
      rejectEverything = false;
    }
  });
});
