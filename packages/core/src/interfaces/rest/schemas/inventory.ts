import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses } from "./shared.js";

// ─── Request Schemas ─────────────────────────────────────────────────────────

import { InventoryAdjustBodySchema, InventoryReserveBodySchema, InventoryReleaseBodySchema } from "../../../modules/inventory/schemas.js";
export { InventoryAdjustBodySchema, InventoryReserveBodySchema, InventoryReleaseBodySchema };

export const CreateWarehouseBodySchema = z.object({
  name: z.string().openapi({ example: "Main Warehouse" }),
  code: z.string().optional().openapi({ example: "WH-MAIN" }),
  address: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateWarehouseRequest");

// ─── Route Definitions ──────────────────────────────────────────────────────

export const listInventoryLevelsRoute = createRoute({
  method: "get",
  path: "/levels",
  tags: ["Inventory"],
  summary: "List inventory levels",
  description: "Lists all inventory levels, optionally filtered by warehouse or entity.",
  request: {
    query: z.object({
      warehouseId: z.string().uuid().optional().openapi({ example: "uuid" }),
      entityId: z.string().uuid().optional().openapi({ example: "uuid" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }) } },
      description: "Inventory levels",
    },
    ...errorResponses,
  },
});

export const inventoryCheckRoute = createRoute({
  method: "get",
  path: "/check",
  tags: ["Inventory"],
  summary: "Check inventory for entities",
  request: {
    query: z.object({
      entityIds: z.string().optional().openapi({ example: "uuid1,uuid2" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
      description: "Inventory levels",
    },
  },
});

export const listWarehousesRoute = createRoute({
  method: "get",
  path: "/warehouses",
  tags: ["Inventory"],
  summary: "List all warehouses",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
      description: "Warehouses",
    },
  },
});

export const inventoryAdjustRoute = createRoute({
  method: "post",
  path: "/adjust",
  tags: ["Inventory"],
  summary: "Adjust inventory levels",
  description: "Adjusts the on-hand quantity for a given entity/variant in a warehouse.",
  request: {
    body: {
      content: {
        "application/json": { schema: InventoryAdjustBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
      description: "Inventory adjusted.",
    },
    ...errorResponses,
  },
});

export const inventoryReserveRoute = createRoute({
  method: "post",
  path: "/reserve",
  tags: ["Inventory"],
  summary: "Reserve inventory",
  description: "Reserves inventory quantity for an order.",
  request: {
    body: {
      content: {
        "application/json": { schema: InventoryReserveBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.object({ reserved: z.literal(true) }) }) } },
      description: "Inventory reserved.",
    },
    ...errorResponses,
  },
});

export const inventoryReleaseRoute = createRoute({
  method: "post",
  path: "/release",
  tags: ["Inventory"],
  summary: "Release reserved inventory",
  description: "Releases previously reserved inventory back to available stock.",
  request: {
    body: {
      content: {
        "application/json": { schema: InventoryReleaseBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.object({ released: z.literal(true) }) }) } },
      description: "Inventory released.",
    },
    ...errorResponses,
  },
});

export const createWarehouseRoute = createRoute({
  method: "post",
  path: "/warehouses",
  tags: ["Inventory"],
  summary: "Create a warehouse",
  description: "Creates a new warehouse for inventory management.",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateWarehouseBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
      description: "Warehouse created.",
    },
    ...errorResponses,
  },
});
