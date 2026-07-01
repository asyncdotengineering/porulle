import { z } from "@hono/zod-openapi";

// ─── Catalog Body Schemas (single source of truth) ──────────────────────────

export const CreateEntityBodySchema = z.object({
  type: z.string().openapi({ example: "physicalGood" }),
  slug: z.string().openapi({ example: "my-product" }),
  status: z.string().optional().openapi({ example: "draft" }),
  basePrice: z.number().optional().openapi({ example: 29.99 }),
  currency: z.string().optional().openapi({ example: "USD" }),
  metadata: z.record(z.string(), z.unknown()).optional().openapi({ example: { title: "My Product" } }),
  attributes: z.object({
    locale: z.string().optional(),
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    richDescription: z.record(z.string(), z.unknown()).optional(),
    seoTitle: z.string().optional(),
    seoDescription: z.string().optional(),
  }).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateEntityBody");

export const UpdateEntityBodySchema = z.object({
  slug: z.string().optional(),
  status: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  isVisible: z.boolean().optional(),
}).openapi("UpdateEntityBody");

export const SetAttributesBodySchema = z.record(z.string(), z.unknown()).openapi("SetAttributesBody");

export const CreateCategoryBodySchema = z.object({
  slug: z.string().openapi({ example: "shoes" }),
  parentId: z.uuid().optional(),
  sortOrder: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateCategoryBody");

export const UpdateCategoryBodySchema = z.object({
  slug: z.string().optional(),
  parentId: z.uuid().nullable().optional(),
  sortOrder: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateCategoryBody");

export const CreateBrandBodySchema = z.object({
  slug: z.string().openapi({ example: "nike" }),
  displayName: z.string().openapi({ example: "Nike" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateBrandBody");

export const UpdateBrandBodySchema = z.object({
  slug: z.string().optional(),
  displayName: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateBrandBody");

export const CreateOptionTypeBodySchema = z.object({
  name: z.string().openapi({ example: "Color" }),
  values: z.array(z.string()).optional().openapi({ example: ["Red", "Blue"] }),
}).openapi("CreateOptionTypeBody");

export const CreateOptionValueBodySchema = z.object({
  value: z.string().openapi({ example: "Green" }),
}).openapi("CreateOptionValueBody");

export const CreateVariantBodySchema = z.object({
  sku: z.string().optional().openapi({ example: "SKU-001" }),
  options: z.record(z.string(), z.string()).openapi({ example: { Color: "Red" } }),
  price: z.number().optional().openapi({ example: 34.99 }),
}).openapi("CreateVariantBody");

const VariantMatrixRuleSchema = z.object({
  include: z.array(z.array(z.string())).optional().openapi({ example: [["red", "small"]] }),
  exclude: z.array(z.array(z.string())).optional().openapi({ example: [["red", "large"]] }),
});

export const GenerateVariantsBodySchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }),
    z.object({
      mode: z.literal("manual"),
      combinations: z.array(z.array(z.string())).openapi({ example: [["red", "small"]] }),
    }),
    z.object({ mode: z.literal("matrix"), matrix: VariantMatrixRuleSchema }),
  ])
  .openapi("GenerateVariantsBody");

// ─── Derived Input Types ─────────────────────────────────────────────────────

export type CreateEntityInput = z.infer<typeof CreateEntityBodySchema>;

export type UpdateEntityInput = z.infer<typeof UpdateEntityBodySchema>;

export type CreateCategoryInput = z.infer<typeof CreateCategoryBodySchema> & {
  id?: string;
};

export type UpdateCategoryInput = z.infer<typeof UpdateCategoryBodySchema>;

export type CreateBrandInput = z.infer<typeof CreateBrandBodySchema> & {
  id?: string;
};

export type UpdateBrandInput = z.infer<typeof UpdateBrandBodySchema>;

export type CreateOptionTypeInput = z.infer<typeof CreateOptionTypeBodySchema> & {
  entityId: string;
};

export type CreateOptionValueInput = z.infer<typeof CreateOptionValueBodySchema> & {
  optionTypeId: string;
};

export type CreateVariantInput = z.infer<typeof CreateVariantBodySchema> & {
  entityId: string;
};
