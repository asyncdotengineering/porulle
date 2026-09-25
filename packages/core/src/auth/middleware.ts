import type { MiddlewareHandler } from "hono";
import type { CommerceConfig } from "../config/types.js";
import type { Actor } from "./types.js";
import type { AuthInstance } from "./setup.js";
import { getCustomerPermissions, resolveActor } from "./actor.js";
import { DEFAULT_ORG_ID } from "./org.js";
import { credentialRejectionStatus, isCredentialRejection } from "./auth-failure.js";
import { isStrictOrgResolution } from "./strict-org-resolution.js";
import { isIdentityFreeRoute } from "./identity-free-routes.js";

function emptyToNull(value: string | null | undefined): string | null {
  return value == null || value === "" ? null : value;
}

// Exported so the storefront contract can be pinned by a test: an anonymous
// visitor resolved by `storeResolver` gets these permissions, so dropping
// `catalog:read` here would 401 every public storefront read.
export { DEFAULT_CUSTOMER_PERMISSIONS } from "./actor.js";

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
          // Read the org (and operator identity) from key metadata when present.
          // POS shift keys carry { organizationId, operatorId } in metadata so the
          // operator is scoped to their store WITHOUT any org membership/role
          // (SEC-16 / R-01). Other keys fall back to the key's organizationId.
          const rawMeta = apiKey.metadata;
          const meta =
            rawMeta && typeof rawMeta === "object"
              ? (rawMeta as Record<string, unknown>)
              : typeof rawMeta === "string"
                ? (() => {
                    try {
                      return JSON.parse(rawMeta) as Record<string, unknown>;
                    } catch {
                      return null;
                    }
                  })()
                : null;
          const metaOrg = typeof meta?.organizationId === "string" ? meta.organizationId : undefined;
          const orgId = (metaOrg ?? apiKey.organizationId ?? defaultOrgId) as string;
          // No operator and no reference means the key carries no user
          // identity. Leave it absent rather than substituting a shared
          // placeholder, which would make every such key look like one person.
          const userId = emptyToNull(
            (typeof meta?.operatorId === "string" ? meta.operatorId : undefined) ??
              (typeof apiKey.referenceId === "string" ? apiKey.referenceId : undefined),
          );

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
            userId,
            email: null,
            name,
            vendorId: null,
            organizationId: orgId,
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
        if (credentialRejectionStatus(err) === 429) {
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
              { err, actor: actorCtx ?? null, path: c.req.path, method: c.req.method },
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
