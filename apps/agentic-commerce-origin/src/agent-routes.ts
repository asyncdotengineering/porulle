import type { Actor, Kernel } from "@porulle/core";
import type { Hono } from "hono";

type ContextWithActor = { var?: { actor?: Actor | null } };

function actor(c: unknown): Actor | null {
  return (c as ContextWithActor).var?.actor ?? null;
}

function canRead(value: Actor | null): boolean {
  if (!value) return false;
  return value.permissions.some((permission) =>
    permission === "*:*" || permission === "catalog:*" || permission === "catalog:read"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Commerce lookup failed";
}

async function toAgentProduct(kernel: Kernel, id: string, requestActor: Actor) {
  const [entityResult, inventoryResult, priceResult] = await Promise.all([
    kernel.services.catalog.getById(id, { includeAttributes: true, includeMedia: true }, requestActor),
    kernel.services.inventory.getAvailable(id, undefined, undefined, requestActor),
    kernel.services.pricing.resolve({ entityId: id, currency: "USD", quantity: 1 }, requestActor),
  ]);
  if (!entityResult.ok) throw entityResult.error;
  if (!inventoryResult.ok) throw inventoryResult.error;
  if (!priceResult.ok) throw priceResult.error;
  const entity = entityResult.value;
  const attributes = entity.attributes?.find((item) => item.locale === "en") ?? entity.attributes?.[0];
  const metadata = entity.metadata ?? {};
  return {
    id: entity.id,
    slug: entity.slug,
    title: attributes?.title ?? entity.slug,
    description: attributes?.description,
    brand: typeof metadata.brand === "string" ? metadata.brand : undefined,
    category: typeof metadata.category === "string" ? metadata.category : entity.type,
    priceAmount: priceResult.value.finalAmount,
    currency: priceResult.value.currency,
    stock: inventoryResult.value,
    inStock: inventoryResult.value > 0,
    imageUrl: entity.media?.[0]?.url,
    productUrl: typeof metadata.productUrl === "string" ? metadata.productUrl : undefined,
    inventoryCheckedAt: new Date().toISOString(),
    priceUpdatedAt: new Date().toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

export function agentCatalogRoutes(app: Hono, kernel: Kernel): void {
  // Register the literal route before `:id`; Hono matches in declaration order.
  app.get("/agent/catalog/export", async (c) => {
    const requestActor = actor(c);
    if (!canRead(requestActor)) return c.json({ error: "catalog:read is required" }, 403);
    const listed = await kernel.services.catalog.list(
      { filter: { status: "active" }, pagination: { page: 1, limit: 1_000 } },
      requestActor,
    );
    if (!listed.ok) return c.json({ error: errorMessage(listed.error) }, 500);
    const products = await Promise.all(listed.value.items.map((item) => toAgentProduct(kernel, item.id, requestActor!)));
    return c.json({
      data: products.map((product) => ({
        id: product.id,
        data: {
          title: product.title,
          description: product.description,
          brand: product.brand,
          category: product.category,
          price: product.priceAmount,
          currency: product.currency,
          available: product.inStock,
          stock: product.stock,
          image_url: product.imageUrl,
          product_url: product.productUrl,
          inventory_checked_at: product.inventoryCheckedAt,
          price_updated_at: product.priceUpdatedAt,
          updated_at: product.updatedAt,
        },
      })),
    });
  });

  app.get("/agent/catalog/:id", async (c) => {
    const requestActor = actor(c);
    if (!canRead(requestActor)) return c.json({ error: "catalog:read is required" }, 403);
    try {
      return c.json({ data: await toAgentProduct(kernel, c.req.param("id"), requestActor!) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 404);
    }
  });
}
