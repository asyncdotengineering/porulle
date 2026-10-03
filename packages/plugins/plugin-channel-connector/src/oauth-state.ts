import { createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthStatePayload {
  provider: string;
  orgId: string;
  /** The signed-in user who started the connection: the callback arrives with no session of its own. */
  userId: string;
  /** The consumer's connect claims, resolved at start. */
  claims: Record<string, string>;
  shopDomain: string;
  exp: number;
  jti: string;
}

export type OAuthStateResult =
  | { ok: true; value: OAuthStatePayload }
  | { ok: false; error: string };

function encodeText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signState(payload: OAuthStatePayload, secret: string): string {
  if (!secret) throw new Error("OAuth state secret is required.");
  const encodedPayload = encodeText(JSON.stringify(payload));
  return `${encodedPayload}.${encodeBytes(signature(encodedPayload, secret))}`;
}

/**
 * Checks the signature and expiry. Single use is NOT decided here: an in-memory record of used states
 * would forget on every Worker isolate, so the callback records each state's `jti` in the database and
 * refuses a second use there.
 */
export function verifyState(
  state: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): OAuthStateResult {
  if (!secret) return { ok: false, error: "OAuth state secret is required." };
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "Malformed OAuth state." };

  const expected = signature(parts[0], secret);
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, error: "Malformed OAuth state signature." };
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, error: "Invalid OAuth state signature." };
  }

  const decoded = decode(parts[0]);
  if (!decoded) return { ok: false, error: "Malformed OAuth state payload." };
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "Malformed OAuth state payload." };
  }
  if (!payload || typeof payload !== "object") return { ok: false, error: "Malformed OAuth state payload." };
  const candidate = payload as Partial<OAuthStatePayload>;
  const exp = candidate.exp;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.orgId !== "string" ||
    typeof candidate.userId !== "string" ||
    typeof candidate.shopDomain !== "string" ||
    typeof candidate.jti !== "string" ||
    typeof exp !== "number" ||
    !Number.isInteger(exp)
  ) return { ok: false, error: "Malformed OAuth state payload." };
  if (exp <= now) return { ok: false, error: "OAuth state has expired." };
  const claims: unknown = (candidate as { claims?: unknown }).claims;
  if (typeof claims !== "object" || claims === null || Object.values(claims).some((value) => typeof value !== "string")) {
    return { ok: false, error: "Malformed OAuth state payload." };
  }

  return { ok: true, value: candidate as OAuthStatePayload };
}

export function oauthStateEventId(jti: string): string {
  return `oauth-state:${jti}`;
}
