import type { MiddlewareHandler } from "hono";
import type { CommerceConfig } from "../config/types.js";
import type { Actor } from "./types.js";
import type { AuthInstance } from "./setup.js";
import { findMembershipRole, getCustomerPermissions, resolveActor } from "./actor.js";
import { DEFAULT_ORG_ID } from "./org.js";
import { isCredentialRejection } from "./auth-failure.js";
import { isStrictOrgResolution } from "./strict-org-resolution.js";
import { isIdentityFreeRoute } from "./identity-free-routes.js";
import { CommerceTwoFactorRequiredError } from "../kernel/errors.js";
import { describeError } from "../utils/describe-error.js";

function keyMetadata(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const claim = (meta: Record<string, unknown> | null, field: string): string | undefined =>
  typeof meta?.[field] === "string" ? meta[field] : undefined;

/**
 * Who an API key acts as, from facts the server holds: the key's `referenceId` and the `member` table.
 *
 * Metadata is written by whoever may create or update the key (Better Auth turns `enableMetadata` on for every
 * organization-referenced scope here), so a field in it is a CLAIM. A claimed operator or store is accepted only when the
 * `member` table says that user belongs to that organization; a claim that does not hold refuses the key (`null`).
 *
 * - Organization-referenced: the organization is `referenceId`. With no operator the user is `referenceId` too: an
 *   organization id, which matches no membership, so every vendor guard confines it instead of passing it through.
 * - User-referenced (POS shift keys): the user is `referenceId`, acting in the claimed store when a member of it, and in
 *   the default organization when the key claims none.
 */
async function apiKeyIdentity(
  auth: AuthInstance,
  config: CommerceConfig,
  key: Record<string, unknown>,
  configId: string | undefined,
  defaultOrgId: string,
): Promise<{ organizationId: string; userId: string } | null> {
  const referenceId = typeof key.referenceId === "string" && key.referenceId !== "" ? key.referenceId : null;
  if (referenceId === null) return null;
  const scopeId = typeof key.configId === "string" ? key.configId : configId;
  const references = scopeId ? config.auth?.apiKeyScopes?.[scopeId]?.references : undefined;
  const meta = keyMetadata(key.metadata);
  const claimedOrganization = claim(meta, "organizationId");
  const claimedOperator = claim(meta, "operatorId");
  const isMember = async (userId: string, organizationId: string): Promise<boolean> =>
    (await findMembershipRole(auth, userId, organizationId)) !== undefined;

  if (references === "organization") {
    if (claimedOrganization !== undefined && claimedOrganization !== referenceId) return null;
    if (claimedOperator === undefined) return { organizationId: referenceId, userId: referenceId };
    return (await isMember(claimedOperator, referenceId)) ? { organizationId: referenceId, userId: claimedOperator } : null;
  }

  if (claimedOperator !== undefined && claimedOperator !== referenceId) return null;
  if (claimedOrganization === undefined) return { organizationId: defaultOrgId, userId: referenceId };
  return (await isMember(referenceId, claimedOrganization)) ? { organizationId: claimedOrganization, userId: referenceId } : null;
}


/**
 * The challenge RFC 9110 §15.5.2 requires on a 401: it "MUST include a WWW-Authenticate header
 * field containing at least one challenge applicable to the target resource". Without it a 401
 * names no scheme, so it is advice a generic HTTP client cannot act on.
 *
 * `Bearer` and nothing else. Both credentials this API accepts — the session cookie the mobile
 * client holds and the `x-api-key` a machine holds — are presented as bearer-style tokens, and a
 * `Basic` challenge would make a browser render a native credential prompt over a JSON API.
 *
 * The realm is a constant. It must never carry the organization or vendor, which would disclose
 * tenancy to a caller that has not authenticated.
 */
export const AUTHENTICATE_CHALLENGE = 'Bearer realm="api"';

/**
 * Attach the challenge to a 401, and to nothing else.
 *
 * NOT unconditional: §15.5.4 asks no challenge of a 403, and offering one there tells a caller who
 * IS authenticated to try authenticating again. An existing header is left alone so a plugin or a
 * route can answer with a more specific challenge than this default.
 */
export function applyAuthenticateChallenge(response: Response): void {
  if (response.status !== 401) return;
  if (response.headers.has("www-authenticate")) return;
  response.headers.set("www-authenticate", AUTHENTICATE_CHALLENGE);
}

const LEGACY_STORE_RESOLVER_WARN_COOLDOWN_MS = 60_000;
let lastLegacyStoreResolverWarnAt = 0;

export function authMiddleware(
  auth: AuthInstance,
  config: CommerceConfig,
): MiddlewareHandler {
  /**
   * The resolution body. It has FIVE `next()` call sites and four of them `return` immediately
   * after — a signed-in caller leaves at the `if (actor)` branch, an API-key caller at its own,
   * and only an anonymous caller reaches the last one. Anything that must run for EVERY request
   * therefore cannot live at the bottom of this function: it would fire for one caller class and
   * silently skip the rest. Measured, not assumed — a header set at the bottom reached an
   * anonymous 401 and never reached a signed-in 403.
   */
  const resolve: MiddlewareHandler = async (c, next) => {
    if (isIdentityFreeRoute(c.req.method, c.req.path, config)) {
      c.set("actor", null);
      await next();
      return;
    }

    // Resolve the default org from config, falling back to deprecated constant
    const defaultOrgId = config.auth?.defaultOrganizationId ?? DEFAULT_ORG_ID;

    // Test-only actor injection: requires NODE_ENV === "test" AND an explicit
    // config opt-in so staging/preview deployments left as NODE_ENV=test do not
    // silently become a full auth bypass.
    if (process.env.NODE_ENV === "test" && config.auth?.allowTestActor) {
      const testActorHeader = c.req.header("x-test-actor");
      if (testActorHeader) {
        try {
          const actor = JSON.parse(testActorHeader) as Actor;
          c.set("actor", actor);
          await next();
          return;
        } catch {
          // Invalid JSON — continue to real auth resolution.
        }
      }
    }

    // A caller told "Authentication required." goes and checks their
    // credential. When the check never ran, that answer is a lie and there is
    // nothing in the log to correct it. Report a fault as a fault.
    const reportAuthCheckFault = (err: unknown, stage: string): void => {
      c.get("logger")?.error(
        { err, stage, path: c.req.path, method: c.req.method },
        "auth check failed — the credential was never evaluated, so this is not an authentication failure",
      );
    };

    let actor: Actor | null;
    try {
      actor = await resolveActor(c.req.raw.headers, auth, config, c.req.raw);
    } catch (err) {
      // An evaluated credential that the role policy refuses — not a fault.
      if (err instanceof CommerceTwoFactorRequiredError) {
        return c.json({ error: { code: err.code, message: err.message } }, 403);
      }
      reportAuthCheckFault(err, "session");
      throw err;
    }
    if (actor) {
      c.set("actor", actor);
      await next();
      return;
    }

    // Extract API key from headers
    const apiKeyHeader =
      c.req.header("x-api-key") ??
      c.req.header("authorization")?.replace("Bearer ", "");

    if (
      apiKeyHeader &&
      config.auth?.apiKeys?.enabled &&
      auth.api.verifyApiKey
    ) {
      try {
        // Resolve the key's configId from its prefix. Better Auth's apiKey
        // plugin throws "No default api-key configuration found" when named
        // scopes are configured and none is `default`/unset — and verifyApiKey
        // only resolves a named scope (and enforces its configId match) when
        // the configId is forwarded. Match the key's prefix to a configured
        // scope so named-scope keys authenticate instead of silently 401-ing.
        let configId: string | undefined;
        const scopes = config.auth?.apiKeyScopes;
        if (scopes) {
          for (const [scopeId, scope] of Object.entries(scopes)) {
            if (scope.prefix && apiKeyHeader.startsWith(scope.prefix)) {
              configId = scopeId;
              break;
            }
          }
        }

        // Better Auth server-side calls require { body: { ... } } wrapper.
        // Returns { valid, error, key: Omit<ApiKey,"key"> | null }.
        // See: https://better-auth.com/docs/plugins/api-key/reference
        const result = await auth.api.verifyApiKey({
          body: { key: apiKeyHeader, ...(configId ? { configId } : {}) },
        });
        if (result?.valid && result.key) {
          const apiKey = result.key as Record<string, unknown>;

          const name = (apiKey.name ?? "API Key") as string;
          const identity = await apiKeyIdentity(auth, config, apiKey, configId, defaultOrgId);
          if (identity === null) {
            const refused = c.json({ error: { code: "UNAUTHORIZED", message: "The presented credential could not be verified." } }, 401);
            applyAuthenticateChallenge(refused);
            return refused;
          }

          // Better Auth stores permissions as Record<string, string[]>
          // (e.g. {"catalog":["read","create"]}).  Flatten to the
          // "resource:action" string[] format the engine expects.
          let permissions: string[];
          const rawPerms = apiKey.permissions;
          if (Array.isArray(rawPerms)) {
            permissions = rawPerms;
          } else if (rawPerms && typeof rawPerms === "object") {
            permissions = [];
            for (const [resource, actions] of Object.entries(
              rawPerms as Record<string, string[]>,
            )) {
              for (const action of actions) {
                permissions.push(`${resource}:${action}`);
              }
            }
          } else {
            permissions = config.auth?.apiKeys?.defaultPermissions ?? [];
          }

          c.set("actor", {
            type: "api_key",
            userId: identity.userId,
            email: null,
            name,
            vendorId: null,
            organizationId: identity.organizationId,
            role: "api_key",
            permissions,
          } satisfies Actor);
          await next();
          return;
        }
      } catch (err) {
        // A rejection better-auth raised was an evaluated credential; anything else means the key
        // was never checked, and is a fault. A rate-limited key is not a bad one: say so.
        if (!isCredentialRejection(err)) {
          reportAuthCheckFault(err, "api_key");
          throw err;
        }
        if (err.statusCode === 429) {
          return c.json({ error: { code: "RATE_LIMITED", message: "Too many requests for this credential." } }, 429);
        }
      }
    }

    // A credential the caller PRESENTED and that did not verify is refused, not served as a guest.
    // Falling through to anonymous gave a shopper whose token had expired a fresh guest cart in
    // place of theirs, and told a broken client nothing. Absent credentials stay anonymous (guest
    // checkout depends on it), and a stale session COOKIE is not "presented": browsers carry one on
    // every public page, and refusing it would 401 logged-out browsing.
    const presented = (c.req.header("x-api-key") ?? "").trim() !== "" || (c.req.header("authorization") ?? "").trim() !== "";
    if (presented) {
      const refused = c.json({ error: { code: "UNAUTHORIZED", message: "The presented credential could not be verified." } }, 401);
      applyAuthenticateChallenge(refused);
      return refused;
    }

    if (!c.get("actor")) {
      // For anonymous requests in multi-store deployments, resolve the
      // store so catalog/search queries return the right store's data.
      if (config.auth?.storeResolver) {
        try {
          const resolved = await config.auth.storeResolver(c.req.raw);
          if (resolved) {
            // Set a minimal anonymous actor with the resolved org so
            // services can scope queries correctly.
            c.set("actor", {
              type: "user",
              userId: null,
              email: null,
              name: "Anonymous",
              vendorId: null,
              organizationId: resolved,
              role: "customer",
              permissions: getCustomerPermissions(config),
            } satisfies Actor);
          }
        } catch (err) {
          if (isStrictOrgResolution(config)) {
            const actorCtx = c.get("actor");
            console.error(
              { error: describeError(err), actor: actorCtx ?? null, path: c.req.path, method: c.req.method },
              "storeResolver failed while resolving organization (strict org resolution)",
            );
            const message =
              err instanceof Error ? err.message : String(err);
            return c.json(
              {
                error: {
                  code: "ORG_RESOLUTION_FAILED",
                  message:
                    message || "Organization resolution failed for this request.",
                },
              },
              503,
            );
          }
          const now = Date.now();
          if (now - lastLegacyStoreResolverWarnAt >= LEGACY_STORE_RESOLVER_WARN_COOLDOWN_MS) {
            lastLegacyStoreResolverWarnAt = now;
            console.warn(
              { err, path: c.req.path, method: c.req.method },
              "storeResolver failed; continuing without actor (legacy org resolution)",
            );
          }
        }
      }
      if (!c.get("actor")) {
        c.set("actor", null);
      }
    }
    await next();
  };

  // ONE boundary around all five of the body's exits. A 401 leaves this server by five routes —
  // `requirePerm` and `requireAnyPerm` in interfaces/rest/utils.ts, the plugin router's inline
  // refusal, the customer portal's own, and a thrown `CommerceUnauthorizedError` shaped by
  // `mapErrorToResponse` — and every one of them unwinds through here whichever way the body
  // returned. So one line covers all five, and any sixth refusal added later, which five copies of
  // the rule could not.
  //
  // The only 401 that does NOT reach this point is one produced by `app.onError`: by then every
  // `await next()` in the chain has already rejected. runtime/server.ts calls the same helper there.
  return async (c, next) => {
    // The body RETURNS a Response on one path — the strict-org-resolution 503 — and Hono assigns
    // that return value over `c.res` after this handler finishes. Dropping it on the floor turned
    // two `ORG_RESOLUTION_FAILED` rows red, and challenging `c.res` instead of the returned object
    // would have mutated a response that was about to be replaced. Both cases are handled by
    // challenging whichever object is actually going to be sent.
    const returned = await resolve(c, next);
    if (returned instanceof Response) {
      applyAuthenticateChallenge(returned);
      return returned;
    }
    applyAuthenticateChallenge(c.res);
    return;
  };
}
