import { beforeAll, describe, expect, it } from "vitest";
import type { Actor, JobsAdapter } from "@porulle/core";
import { createPluginTestApp, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { connectedStores } from "../src/schema.js";

/**
 * `executeCatalogPushJob` resolved the store's connector and answered `Ok({ noop: true })` when the
 * lookup produced nothing. Two different situations reached that one line:
 *
 *   - a REGISTERED connector that cannot push a catalog — a legitimate no-op, and
 *   - a provider that is not registered at all — a store pointing at nothing.
 *
 * Only the first is benign. The second is the failure shape this program keeps being bitten by: the
 * caller gets a success, nothing is written, and no log line says why. It became reachable the day
 * the mock connector was removed from the deployed Worker and left a store row behind whose provider
 * no longer registers.
 *
 * The rows below are written as a PAIR on purpose. A single row asserting "does not throw" passes
 * whether or not the two cases are told apart, and a single row asserting "errors" would be
 * satisfied by making the write-disabled path error too — which would break every store an operator
 * deliberately turned catalog writes off for.
 */

const actor: Actor = {
  type: "user",
  userId: "unregistered-connector-admin",
  email: "unregistered-connector-admin@test.local",
  name: "Unregistered Connector Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

/**
 * The test kernel exposes a jobs adapter that its `services` type does not declare. Checked at
 * runtime and thrown on rather than reached through `as unknown as`, so a harness that stops
 * providing it fails here with a sentence instead of at an undefined dereference later.
 */
function jobsAdapterOf(services: object): JobsAdapter {
  if (!("jobs" in services)) throw new Error("test harness exposes no jobs adapter");
  return services.jobs as JobsAdapter;
}

const WRITE_ENABLED_STORE = "00000000-0000-4000-8000-0000000009a1";
const WRITE_DISABLED_STORE = "00000000-0000-4000-8000-0000000009a2";

describe("a store whose connector is unregistered never answers a silent no-op", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let jobs: JobsAdapter;

  /** The mock connector with its catalog push removed — registered, but push-less. */
  const { pushCatalog: _omitted, ...pushlessConnector } = mockChannelConnector({ catalog: [] });

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mockChannelConnector({ catalog: [] })] }));
    jobs = jobsAdapterOf(built.kernel.services);

    for (const [id, catalogWriteEnabled] of [
      [WRITE_ENABLED_STORE, true],
      [WRITE_DISABLED_STORE, false],
    ] as const) {
      await built.db.insert(connectedStores).values({
        id,
        organizationId: TEST_ORG_ID,
        provider: "mock",
        credentials: {},
        storeDomain: `${id}.mock.channel.test`,
        status: "connected",
        webhookSecret: null,
        catalogWriteEnabled,
      });
    }
  }, 30_000);

  function serviceWith(connectors: unknown[]): ChannelConnectorService {
    return new ChannelConnectorService(built.db, built.kernel.services, {
      connectors: connectors as never,
    });
  }

  it("is a no-op when the connector IS registered and simply cannot push a catalog", async () => {
    const result = await serviceWith([pushlessConnector]).executeCatalogPushJob(
      TEST_ORG_ID,
      WRITE_ENABLED_STORE,
      {},
      actor,
      { jobs },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({ noop: true });
  });

  it("REFUSES, naming the provider, when the store's connector is not registered at all", async () => {
    const result = await serviceWith([]).executeCatalogPushJob(
      TEST_ORG_ID,
      WRITE_ENABLED_STORE,
      {},
      actor,
      { jobs },
    );

    expect(result.ok).toBe(false);
    // Narrowed rather than reached through a `&&`, so the assertions below read the refusal
    // itself. `PluginResult`'s error is a string (`kernel/result.ts`), not an Error.
    if (result.ok) throw new Error("expected a refusal, got a no-op");
    expect(result.error).toContain("No connector registered");
    expect(result.error).toContain("mock");
  });

  /**
   * The row the repair must not break. `catalogWriteEnabled: false` is an operator's deliberate
   * choice and stays a no-op even with no connector registered — it is decided before the connector
   * is ever looked up, and a fix that also made this path error would break every such store.
   */
  it("stays a no-op when the operator turned catalog writes off, connector or not", async () => {
    const result = await serviceWith([]).executeCatalogPushJob(
      TEST_ORG_ID,
      WRITE_DISABLED_STORE,
      {},
      actor,
      { jobs },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({ noop: true });
  });
});
