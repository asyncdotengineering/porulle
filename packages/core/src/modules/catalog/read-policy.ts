import type { Actor } from "../../auth/types.js";

type CatalogVisibility = {
  status: string;
  isVisible: boolean;
};

function hasPermission(actor: Actor | null, permission: string): boolean {
  if (!actor) return false;
  const [resource] = permission.split(":");
  return actor.permissions.includes(permission) ||
    actor.permissions.includes("*:*") ||
    (resource !== undefined && actor.permissions.includes(`${resource}:*`));
}

export function canReadUnpublishedCatalog(actor: Actor | null): boolean {
  return hasPermission(actor, "catalog:update");
}

export function isCatalogEntityVisible(entity: CatalogVisibility, actor: Actor | null): boolean {
  return canReadUnpublishedCatalog(actor) ||
    (entity.status === "active" && entity.isVisible);
}
