import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Known typed groups. Every field is optional (PATCH is a partial merge) and
// nullable (null deletes the key). Unknown groups accept any flat JSON object
// so plugins can namespace their own settings.
export const GeneralSettingsPatchSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 uppercase code").nullable().optional(),
  timezone: z.string().refine(isValidTimezone, "Must be a valid IANA timezone (e.g. Asia/Colombo)").nullable().optional(),
  locale: z.string().min(2).nullable().optional(),
}).strict();

export const BrandingSettingsPatchSchema = z.object({
  storeName: z.string().nullable().optional(),
  receiptHeader: z.string().nullable().optional(),
  receiptFooter: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  taxId: z.string().nullable().optional(),
}).strict();

export const PoliciesSettingsPatchSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const KNOWN_GROUP_SCHEMAS: Record<string, z.ZodTypeAny> = {
  general: GeneralSettingsPatchSchema,
  branding: BrandingSettingsPatchSchema,
  policies: PoliciesSettingsPatchSchema,
};

const GroupParam = z.object({
  group: z.string().regex(/^[a-z][a-z0-9_-]*$/).openapi({ example: "branding" }),
});

const SettingsPatchBodySchema = z
  .record(z.string(), z.unknown())
  .openapi("SettingsPatchRequest", {
    description:
      "Shallow merge into the group: keys overwrite, null deletes a key. Known groups (general, branding, policies) are validated.",
  });

const DataResponse = z.object({ data: z.any() }).openapi("SettingsResponse");

export const getAllSettingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Settings"],
  summary: "Get all settings groups for the organization",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "All settings groups" },
    ...errorResponses,
  },
});

export const getSettingsGroupRoute = createRoute({
  method: "get",
  path: "/{group}",
  tags: ["Settings"],
  summary: "Get one settings group",
  request: { params: GroupParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Settings group (empty object if unset)" },
    ...errorResponses,
  },
});

export const patchSettingsGroupRoute = createRoute({
  method: "patch",
  path: "/{group}",
  tags: ["Settings"],
  summary: "Merge values into a settings group",
  request: {
    params: GroupParam,
    body: { content: { "application/json": { schema: SettingsPatchBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "The merged group value" },
    ...errorResponses,
  },
});
