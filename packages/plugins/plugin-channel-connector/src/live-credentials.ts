import { CHANNEL_CREDENTIALS_REJECTED, Err, Ok } from "@porulle/core";
import type { ChannelConnector, ChannelConnectorError, ChannelStore, PluginDb, Result } from "@porulle/core";
import { and, eq, sql } from "@porulle/core/drizzle";
import { connectedStores } from "./schema.js";

/**
 * The store with credentials good for the next call.
 *
 * A provider that grants EXPIRING credentials (Shopify: a one-hour access token and a rotating
 * refresh token) says so through `liveCredentials`; this asks it and persists what it returns.
 *
 * Persisting is a compare-and-swap on the credentials the call started from. Two Workers that both
 * find the token expiring both refresh; the first write wins and the second, finding the row moved,
 * adopts what the first wrote rather than overwriting a newer refresh token with its own. (Shopify
 * keeps a presented refresh token usable until the app presents the newer one, and a retired access
 * token valid until its own expiry, so the loser's in-flight call still succeeds.)
 *
 * A refusal that is not retriable means the grant is gone — the merchant uninstalled, or the refresh
 * token lapsed. The store is then marked `error`, so it reads as "reconnect" instead of failing every
 * later call with a credential error nobody is shown.
 */
/** Why a store whose key the provider refused is in `error`. */
export const CREDENTIALS_REJECTED_REASON = "The store no longer accepts the key it gave us (it was revoked, or the user who approved it was removed). Reconnect the store.";

export async function resolveLiveCredentials(connector: ChannelConnector, db: PluginDb, store: ChannelStore, options: { force?: boolean } = {}): Promise<Result<ChannelStore, ChannelConnectorError>> {
  if (!connector.liveCredentials) return Ok(store);
  const answer = await connector.liveCredentials(store, options);
  if (!answer.ok) {
    if (answer.error.retriable !== true) {
      const statusReason = answer.error.code === CHANNEL_CREDENTIALS_REJECTED ? CREDENTIALS_REJECTED_REASON : answer.error.message;
      await db.update(connectedStores).set({ status: "error", statusReason, updatedAt: new Date() }).where(eq(connectedStores.id, store.id));
    }
    return answer;
  }
  if (answer.value === null) return Ok(store);
  const swapped = await db.update(connectedStores)
    .set({ credentials: answer.value, updatedAt: new Date() })
    .where(and(eq(connectedStores.id, store.id), sql`${connectedStores.credentials} = ${JSON.stringify(store.credentials)}::jsonb`))
    .returning({ id: connectedStores.id });
  if (swapped.length > 0) return Ok({ ...store, credentials: answer.value });
  const [current] = await db.select({ credentials: connectedStores.credentials }).from(connectedStores).where(eq(connectedStores.id, store.id));
  if (!current) return Err({ code: "STORE_NOT_FOUND", message: `Connected store ${store.id} no longer exists.`, retriable: false });
  return Ok({ ...store, credentials: current.credentials });
}

type StoreCall<A extends unknown[], T> = (store: ChannelStore, ...args: A) => Promise<Result<T, ChannelConnectorError>>;

async function markCredentialsRejected(db: PluginDb, storeId: string): Promise<void> {
  await db.update(connectedStores).set({ status: "error", statusReason: CREDENTIALS_REJECTED_REASON, updatedAt: new Date() }).where(eq(connectedStores.id, storeId));
}

/**
 * The connector with every store-taking method routed through {@link resolveLiveCredentials}, so no
 * call site can start on a lapsed token by forgetting to ask.
 *
 * A call the provider answers with {@link CHANNEL_CREDENTIALS_REJECTED} — a token retired before its
 * stated expiry — is retried ONCE on credentials refreshed by force, for a connector that can refresh.
 * A rejection that cannot be refreshed away (a second one, or a connector whose keys never expire,
 * such as WooCommerce's) marks the store `error` so it reads as "reconnect".
 */
export function withLiveCredentials(connector: ChannelConnector, db: PluginDb): ChannelConnector {
  const around = <A extends unknown[], T>(call: StoreCall<A, T>): StoreCall<A, T> => async (store, ...args) => {
    const current = await resolveLiveCredentials(connector, db, store);
    if (!current.ok) return current;
    const first = await call.call(connector, current.value, ...args);
    if (first.ok || first.error.code !== CHANNEL_CREDENTIALS_REJECTED) return first;
    if (!connector.liveCredentials) {
      await markCredentialsRejected(db, store.id);
      return first;
    }
    const refreshed = await resolveLiveCredentials(connector, db, current.value, { force: true });
    if (!refreshed.ok) return refreshed;
    const second = await call.call(connector, refreshed.value, ...args);
    if (!second.ok && second.error.code === CHANNEL_CREDENTIALS_REJECTED) await markCredentialsRejected(db, store.id);
    return second;
  };
  return {
    ...connector,
    importCatalog: around(connector.importCatalog),
    fetchInventory: around(connector.fetchInventory),
    pushOrder: around(connector.pushOrder),
    fetchOrderStatus: around(connector.fetchOrderStatus),
    refundExecute: around(connector.refundExecute),
    ...(connector.fetchInventoryPage ? { fetchInventoryPage: around(connector.fetchInventoryPage) } : {}),
    ...(connector.fetchCatalogItems ? { fetchCatalogItems: around(connector.fetchCatalogItems) } : {}),
    ...(connector.fetchStoreProfile ? { fetchStoreProfile: around(connector.fetchStoreProfile) } : {}),
    ...(connector.pushCatalog ? { pushCatalog: around(connector.pushCatalog) } : {}),
    ...(connector.reserve ? { reserve: around(connector.reserve) } : {}),
    ...(connector.registerWebhooks ? { registerWebhooks: around(connector.registerWebhooks) } : {}),
    ...(connector.unregisterWebhooks ? { unregisterWebhooks: around(connector.unregisterWebhooks) } : {}),
    ...(connector.webhookHealth ? { webhookHealth: around(connector.webhookHealth) } : {}),
    ...(connector.decodeWebhook ? { decodeWebhook: around(connector.decodeWebhook) } : {}),
    ...(connector.orderEvents ? { orderEvents: around(connector.orderEvents) } : {}),
    ...(connector.cancelOrder ? { cancelOrder: around(connector.cancelOrder) } : {}),
    ...(connector.requestReturn ? { requestReturn: around(connector.requestReturn) } : {}),
  };
}
