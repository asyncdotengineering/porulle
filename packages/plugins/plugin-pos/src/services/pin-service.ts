import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { member, user } from "@porulle/core/auth-schema";
import { posOperatorPins, posShifts } from "../schema.js";
import type { Db, OperatorPin, Shift } from "../types.js";

/**
 * PIN auth runtime (issue #51).
 *
 * PINs hash with PBKDF2-SHA256 via Web Crypto (Workers-safe, no Node-only
 * APIs). PIN login verifies the operator's PIN against their open shift and
 * mints a short-lived Better Auth API key scoped to POS operation — the
 * per-shift credential POS apps previously hand-rolled through module-global
 * auth holders. Manager override verifies a PIN whose record carries
 * `canOverride` and returns an audited approval.
 */

const PBKDF2_ITERATIONS = 100_000;

/** Narrow Better Auth surface the PIN runtime uses. */
export interface PinAuthApi {
  api: {
    createApiKey(input: { body: Record<string, unknown> }): Promise<unknown>;
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveHash(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt.slice().buffer as ArrayBuffer, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPinHash(pin: string, encoded: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltB64, hashB64] = encoded.split("$");
  if (scheme !== "pbkdf2" || !iterationsRaw || !saltB64 || !hashB64) return false;
  const expected = fromBase64(hashB64);
  const actual = await deriveHash(pin, fromBase64(saltB64), Number(iterationsRaw));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

async function ensureOperatorOrgMembership(
  db: Db,
  orgId: string,
  operatorId: string,
): Promise<void> {
  const users = await db.select().from(user).where(eq(user.id, operatorId));
  if (users.length === 0) {
    await db.insert(user).values({
      id: operatorId,
      name: operatorId,
      email: `${operatorId}@pos.local`,
      emailVerified: true,
    });
  }

  const members = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, operatorId)));
  if (members.length === 0) {
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: operatorId,
      role: "owner",
      createdAt: new Date(),
    });
  }
}

export class PinService {
  constructor(
    private db: Db,
    private options: {
      /** Named auth.apiKeyScopes config used to mint shift keys (optional). */
      apiKeyScope?: string | undefined;
      /** Shift-credential lifetime in seconds. Default: 12h. */
      credentialTtlSeconds?: number | undefined;
    } = {},
  ) {}

  async setPin(
    orgId: string,
    input: { operatorId: string; pin: string; canOverride?: boolean | undefined },
  ): Promise<PluginResult<{ operatorId: string; canOverride: boolean }>> {
    if (!/^\d{4,8}$/.test(input.pin)) {
      return Err("PIN must be 4-8 digits");
    }
    const pinHash = await hashPin(input.pin);
    const existing = await this.db
      .select()
      .from(posOperatorPins)
      .where(and(
        eq(posOperatorPins.organizationId, orgId),
        eq(posOperatorPins.operatorId, input.operatorId),
      ));
    if (existing.length > 0) {
      await this.db
        .update(posOperatorPins)
        .set({
          pinHash,
          canOverride: input.canOverride ?? (existing[0] as OperatorPin).canOverride,
          updatedAt: new Date(),
        })
        .where(eq(posOperatorPins.id, (existing[0] as OperatorPin).id));
    } else {
      await this.db.insert(posOperatorPins).values({
        organizationId: orgId,
        operatorId: input.operatorId,
        pinHash,
        canOverride: input.canOverride ?? false,
      });
    }
    return Ok({ operatorId: input.operatorId, canOverride: input.canOverride ?? false });
  }

  private async verifyOperatorPin(
    orgId: string,
    operatorId: string,
    pin: string,
  ): Promise<OperatorPin | null> {
    const rows = await this.db
      .select()
      .from(posOperatorPins)
      .where(and(
        eq(posOperatorPins.organizationId, orgId),
        eq(posOperatorPins.operatorId, operatorId),
      ));
    const record = rows[0] as OperatorPin | undefined;
    if (!record) return null;
    return (await verifyPinHash(pin, record.pinHash)) ? record : null;
  }

  /**
   * PIN login: verifies the PIN, resolves the operator's open shift, and
   * mints a short-lived API key bound to it. The terminal's device key
   * authenticates this call (pos:operate); the returned key is personal.
   */
  async pinLogin(
    orgId: string,
    input: { operatorId: string; pin: string; shiftId?: string | undefined },
    auth: PinAuthApi | undefined,
  ): Promise<PluginResult<{
    operatorId: string;
    shiftId: string;
    terminalId: string;
    apiKey: string;
    expiresAt: string;
  }>> {
    const record = await this.verifyOperatorPin(orgId, input.operatorId, input.pin);
    if (!record) return Err("Invalid operator or PIN");

    const conditions = [
      eq(posShifts.organizationId, orgId),
      eq(posShifts.operatorId, input.operatorId),
      eq(posShifts.status, "open"),
    ];
    if (input.shiftId) conditions.push(eq(posShifts.id, input.shiftId));
    const shifts = await this.db.select().from(posShifts).where(and(...conditions));
    const shift = shifts[0] as Shift | undefined;
    if (!shift) return Err("No open shift for this operator — open a shift first");

    if (!auth) {
      return Err("PIN login requires the Better Auth instance (plugin ctx.auth) — are routes mounted by createServer?");
    }

    await ensureOperatorOrgMembership(this.db, orgId, input.operatorId);

    const ttlSeconds = this.options.credentialTtlSeconds ?? 12 * 3600;
    let created: { key?: string; id?: string };
    try {
      created = (await auth.api.createApiKey({
        body: {
          // Better Auth caps name length at 32; the full shift id lives on the
          // shift row (metadata.pinLoginApiKeyId links back).
          name: `pos-shift-${shift.id.slice(0, 8)}`,
          userId: input.operatorId,
          organizationId: orgId,
          expiresIn: ttlSeconds,
          permissions: { pos: ["operate"] },
          metadata: { operatorId: input.operatorId },
          // Shift/terminal binding is recorded on the shift row; the key name
          // carries the shift id for traceability.
          // The plugin registers this scope via its apiKeyScopes manifest.
          configId: this.options.apiKeyScope ?? "pos",
        },
      })) as { key?: string; id?: string };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to mint shift credential";
      return Err(message);
    }
    if (!created?.key) return Err("Failed to mint shift credential");

    // Record the credential on the shift so admins can trace/revoke it.
    await this.db
      .update(posShifts)
      .set({
        metadata: { ...(shift.metadata ?? {}), pinLoginApiKeyId: created.id ?? null },
        updatedAt: new Date(),
      })
      .where(eq(posShifts.id, shift.id));

    return Ok({
      operatorId: input.operatorId,
      shiftId: shift.id,
      terminalId: shift.terminalId,
      apiKey: created.key,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }

  /**
   * Manager override: verifies the manager's PIN (record must carry
   * canOverride) and returns an approval envelope for the requested action.
   */
  async override(
    orgId: string,
    input: { operatorId: string; pin: string; action: string },
  ): Promise<PluginResult<{
    approved: true;
    operatorId: string;
    action: string;
    approvedAt: string;
  }>> {
    const record = await this.verifyOperatorPin(orgId, input.operatorId, input.pin);
    if (!record) return Err("Invalid operator or PIN");
    if (!record.canOverride) return Err("This operator cannot approve overrides");
    return Ok({
      approved: true,
      operatorId: input.operatorId,
      action: input.action,
      approvedAt: new Date().toISOString(),
    });
  }
}
