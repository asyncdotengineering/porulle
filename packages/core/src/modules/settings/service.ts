import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import { CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type { SettingsRepository } from "./repository/index.js";

const GROUP_NAME_RE = /^[a-z][a-z0-9_-]*$/;

interface SettingsServiceDeps {
  repository: SettingsRepository;
}

/**
 * Org-scoped runtime settings (issue #49).
 *
 * REST-facing methods resolve the org from the actor; `read()` is the
 * plugin/hook-facing API — an orgId-keyed lookup with no actor requirement so
 * policy values can be consumed at request time inside any service or hook.
 */
export class SettingsService {
  private repository: SettingsRepository;

  constructor(deps: SettingsServiceDeps) {
    this.repository = deps.repository;
  }

  /** Runtime read for plugins/hooks. Unset groups read as `{}`. */
  async read(
    orgId: string,
    group: string,
    ctx?: TxContext,
  ): Promise<Record<string, unknown>> {
    const row = await this.repository.findByGroup(orgId, group, ctx);
    return row?.value ?? {};
  }

  async getGroup(
    group: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Record<string, unknown>>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return Ok(await this.read(orgId, group, ctx));
  }

  async getAll(
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Record<string, Record<string, unknown>>>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const rows = await this.repository.findAll(orgId, ctx);
    const all: Record<string, Record<string, unknown>> = {};
    for (const row of rows) all[row.group] = row.value;
    return Ok(all);
  }

  /** Shallow merge: keys in `patch` overwrite, `null` deletes the key. */
  async updateGroup(
    group: string,
    patch: Record<string, unknown>,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Record<string, unknown>>> {
    if (!GROUP_NAME_RE.test(group)) {
      return Err(
        new CommerceValidationError(
          "Settings group must match [a-z][a-z0-9_-]* (e.g. general, branding, policies).",
        ),
      );
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const current = await this.read(orgId, group, ctx);
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const row = await this.repository.upsert(orgId, group, next, ctx);
    return Ok(row.value);
  }
}
