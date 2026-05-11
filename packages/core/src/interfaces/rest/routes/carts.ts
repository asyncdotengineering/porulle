import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import type { CreateCartInput, AddCartItemInput } from "../../../modules/cart/schemas.js";
import { createCartRoute, addCartItemRoute, updateCartItemQuantityRoute, getCartRoute, removeCartItemRoute } from "../schemas/carts.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus } from "../utils.js";

export function cartRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (201 | 400 | 422). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(createCartRoute, async (c) => {
    const actor = c.get("actor");
    const result = await kernel.services.cart.create(c.req.valid("json") as CreateCartInput, actor);
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getCartRoute, async (c) => {
    const actor = c.get("actor");
    // Guest carts are gated by the cart secret; clients pass it as either
    // ?secret=... or X-Cart-Secret. Customer carts ignore the secret and
    // require ownership instead.
    const secretParam = c.req.query("secret");
    const secretHeader = c.req.header("x-cart-secret") ?? c.req.header("X-Cart-Secret");
    const secret = secretParam ?? secretHeader ?? undefined;
    const result = await kernel.services.cart.getById(
      c.req.param("id"),
      actor,
      undefined,
      secret,
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (201 | 400 | 422). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(addCartItemRoute, async (c) => {
    const result = await kernel.services.cart.addItem(
      { ...c.req.valid("json"), cartId: c.req.param("id") } as AddCartItemInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (200 | 400 | 422). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(updateCartItemQuantityRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.cart.updateQuantity(
      {
        cartId: c.req.param("id"),
        itemId: c.req.param("itemId"),
        quantity: body.quantity,
      },
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(removeCartItemRoute, async (c) => {
    const result = await kernel.services.cart.removeItem(
      c.req.param("id"),
      c.req.param("itemId"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { deleted: true } });
  });

  return router;
}
