import type { CommerceConfig } from "../config/types.js";

const BUILTIN_ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
};
const CUSTOM_ROLE_RANK = 1;

/**
 * Who may grant which role.
 *
 * Every surface that mints or changes a membership answers this question, and
 * they must all answer it the same way — the admin staff routes, and the guard
 * in front of Better Auth's organization endpoints. Red-team round 6 found the
 * takeover that follows from two surfaces disagreeing, so the arithmetic lives
 * here and nowhere else.
 */

/**
 * Better Auth stores a member's role as a comma-separated list, so `"owner"`
 * and `"owner,admin"` are both owners to it. Commerce role lookups are exact
 * string matches, which is how a composite string used to read as an unknown
 * custom role on one side and an owner on the other.
 */
export function roleParts(role: string | null | undefined): string[] {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function isCompositeRole(role: string | null | undefined): boolean {
  return roleParts(role).length > 1;
}

/** True when any part of the role string is `owner`, matching Better Auth. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return roleParts(role).includes("owner");
}

export function permissionsForRole(config: CommerceConfig, role: string): string[] {
  return config.auth?.roles?.[role]?.permissions ?? [];
}

export function hasPermissionFromList(
  actorPermissions: readonly string[],
  required: string,
): boolean {
  if (actorPermissions.includes("*:*")) return true;

  const [resource] = required.split(":");
  if (resource && actorPermissions.includes(`${resource}:*`)) return true;
  return actorPermissions.includes(required);
}

/**
 * The role's privilege rank. A composite role ranks as its strongest part, so
 * `"owner,admin"` cannot slip past a rank floor by failing an exact lookup.
 */
export function roleRank(config: CommerceConfig, role: string | null | undefined): number {
  const ranks = roleParts(role).map((part) => {
    const builtin = BUILTIN_ROLE_RANK[part];
    if (builtin !== undefined) return builtin;
    if (permissionsForRole(config, part).includes("*:*")) return BUILTIN_ROLE_RANK["admin"]!;
    return CUSTOM_ROLE_RANK;
  });
  return ranks.length > 0 ? Math.max(...ranks) : CUSTOM_ROLE_RANK;
}

export interface Granter {
  role: string;
  permissions: readonly string[];
}

/**
 * A granter may assign `targetRole` only when it already holds every permission
 * that role carries (containment) and outranks or equals it (rank floor).
 */
export function canGrantRole(
  config: CommerceConfig,
  granter: Granter | null,
  targetRole: string,
): boolean {
  if (!granter) return false;
  const contains = permissionsForRole(config, targetRole).every((permission) =>
    hasPermissionFromList(granter.permissions, permission),
  );
  return contains && roleRank(config, granter.role) >= roleRank(config, targetRole);
}

/**
 * The granter a stored membership row represents. Permissions come from the
 * role's current definition, which is the whole point of re-checking authority
 * later: the row is re-read, not the authority the actor had when they acted.
 */
export function granterForRole(config: CommerceConfig, role: string): Granter {
  return { role, permissions: permissionsForRole(config, role) };
}

export function validRoles(config: CommerceConfig): Set<string> {
  return new Set([
    ...Object.keys(config.auth?.roles ?? {}),
    "owner",
    "admin",
    "member",
  ]);
}
