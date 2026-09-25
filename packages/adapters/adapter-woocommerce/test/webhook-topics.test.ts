/**
 * The connector service registers ONE topic list for every provider, named the Shopify way
 * (`products/update`, `inventory_levels/update`, …). WooCommerce's topics are `resource.event`
 * (`product.updated`, `order.created`, …; https://developer.woocommerce.com/docs/apis/rest-api/v1/webhooks/#topics),
 * and it has no inventory topic: stock changes arrive as `product.updated`. The adapter sent the
 * Shopify names through verbatim, so WooCommerce refused the registration (or registered nothing a
 * store would ever fire), and a Woo store never re-synced by webhook.
 *
 * Contract: given the service's canonical list, the adapter registers only WooCommerce topics, and a
 * delivery it verifies is reported under the canonical name the service handles.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { wooConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "woocommerce", credentials: { consumerKey: "ck", consumerSecret: "cs" }, storeDomain: "https://shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

/** The list `ChannelConnectorService` registers on connect. */
const SERVICE_TOPICS = ["products/update", "products/delete", "inventory_levels/update", "orders/fulfilled", "orders/cancelled", "refunds/create", "app/uninstalled"];
const WOO_TOPIC = /^(product|order|coupon|customer)\.(created|updated|deleted|restored)$/;

describe("WooCommerce webhook topics", () => {
  it("registers only topics WooCommerce accepts, never a Shopify-named one", async () => {
    const registered: string[] = [];
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { topic?: string };
      if (body.topic) registered.push(body.topic);
      return new Response(JSON.stringify({ id: registered.length }), { status: 201, headers: { "content-type": "application/json" } });
    } });
    if (!connector.registerWebhooks) throw new Error("the WooCommerce adapter registers webhooks");

    const result = await connector.registerWebhooks(store, SERVICE_TOPICS, "https://platform.example/api/channels/webhooks/store-1");

    expect(result.ok).toBe(true);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((topic) => !WOO_TOPIC.test(topic))).toEqual([]);
    // Stock and product changes both arrive as product.updated; it must be registered.
    expect(registered).toContain("product.updated");
  });

  it("reports a verified product.updated delivery under the canonical name the service handles", async () => {
    const connector = wooConnector({ fetchImpl: async () => new Response("{}") });
    if (!connector.verifyWebhook) throw new Error("the WooCommerce adapter verifies webhooks");
    const body = JSON.stringify({ id: 42, name: "Linen shirt" });
    const signature = createHmac("sha256", store.webhookSecret).update(body).digest("base64");
    const request = new Request("https://platform.example/api/channels/webhooks/store-1", {
      method: "POST",
      headers: { "x-wc-webhook-signature": signature, "x-wc-webhook-id": "7", "x-wc-webhook-topic": "product.updated" },
      body,
    });

    const verified = await connector.verifyWebhook(store, request);

    expect(verified.ok && verified.value.type).toBe("products/update");
  });
});
