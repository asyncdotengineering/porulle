import { resolveOrgIdForCommerce, isValidFieldPath, type FieldOwner } from "@porulle/core";
import type { HookContext } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { catalogPushConcurrencyKey } from "./service.js";
import { channelEntityMap } from "./schema.js";

type CatalogUpdateInput = {
  slug?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  customFields?: Record<string, unknown | null>;
};

export const CHANNEL_CONVERGENCE_ORIGIN = "channel-convergence";

export const CHANNEL_CONVERGENCE_CTX = {
  hookContext: { origin: CHANNEL_CONVERGENCE_ORIGIN },
};

interface CatalogOwnershipService {
  resolveFieldOwners(entityId: string, storeId: string): Promise<Map<string, FieldOwner>>;
}

function updateInputFieldPaths(input: CatalogUpdateInput): string[] {
  const paths: string[] = [];
  if (input.slug !== undefined) paths.push("entity.slug");
  if (input.status !== undefined) paths.push("entity.status");
  if (input.metadata) {
    for (const key of Object.keys(input.metadata)) paths.push(`entity.metadata.${key}`);
  }
  if (input.customFields) {
    for (const name of Object.keys(input.customFields)) paths.push(`customFields.${name}.en`);
  }
  return paths.filter(isValidFieldPath);
}

export async function maybeEnqueueCatalogPush(args: {
  entityId: string;
  changedFieldPaths: string[];
  context: HookContext;
}): Promise<void> {
  if (args.context.context.origin === CHANNEL_CONVERGENCE_ORIGIN) return;
  if (args.changedFieldPaths.length === 0) return;

  const orgId = resolveOrgIdForCommerce(args.context.actor, args.context.commerceConfig);
  const catalog = args.context.services.catalog as CatalogOwnershipService;
  const mappings = await args.context.db
    .select({ storeId: channelEntityMap.storeId })
    .from(channelEntityMap)
    .where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.entityId, args.entityId),
      eq(channelEntityMap.kind, "entity"),
    ));

  const forceFieldPathsByStore = new Map<string, string[]>();
  for (const mapping of mappings) {
    const owners = await catalog.resolveFieldOwners(args.entityId, mapping.storeId);
    const changedPaths = args.changedFieldPaths.filter((path) => {
      const owner = owners.get(path);
      return owner === "platform" || owner === "shared";
    });
    if (changedPaths.length > 0) forceFieldPathsByStore.set(mapping.storeId, changedPaths);
  }

  await Promise.all([...forceFieldPathsByStore].map(([storeId, forceFieldPaths]) => args.context.jobs.enqueue(
    "channel/push-catalog",
    {
      organizationId: orgId,
      storeId,
      entityIds: [args.entityId],
      forceFieldPaths: { [args.entityId]: forceFieldPaths },
    },
    {
      organizationId: orgId,
      concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds: [args.entityId] }),
      supersedes: true,
    },
  )));
}

export function recordUpdateFieldPaths(input: CatalogUpdateInput, context: HookContext): CatalogUpdateInput {
  context.context.changedFieldPaths = updateInputFieldPaths(input);
  return input;
}

export async function handleCatalogAfterUpdate(args: {
  result: { id: string };
  context: HookContext;
}): Promise<void> {
  const changedFieldPaths = Array.isArray(args.context.context.changedFieldPaths)
    ? args.context.context.changedFieldPaths.map(String)
    : [];
  await maybeEnqueueCatalogPush({
    entityId: args.result.id,
    changedFieldPaths,
    context: args.context,
  });
}
