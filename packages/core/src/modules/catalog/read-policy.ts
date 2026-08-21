import { hasPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";

type CatalogVisibility = {
  status: string;
  isVisible: boolean;
};

export function canReadUnpublishedCatalog(actor: Actor | null): boolean {
  return hasPermission(actor, "catalog:read:unpublished");
}

export function isCatalogEntityVisible(entity: CatalogVisibility, actor: Actor | null): boolean {
  return canReadUnpublishedCatalog(actor) ||
    (entity.status === "active" && entity.isVisible);
}
