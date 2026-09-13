/**
 * Routes that read no actor, so `authMiddleware` need not resolve one.
 *
 * THE DEFAULT IS TO RESOLVE. A route absent from this list keeps its actor,
 * because the failure mode of the opposite default is silent: a route that
 * stops receiving an actor does not throw, it 401s, or takes an anonymous
 * branch and answers.
 *
 * Matching is EXACT on method and path — no patterns, no prefixes. A pattern is
 * how one entry silently widens to cover a route that does need an identity,
 * and this list is small enough that the cost of exactness is a line per route.
 * A route with a path parameter therefore cannot be listed at all, which is the
 * intended limit rather than an oversight.
 *
 * Entries are the routes whose handlers were read and shown to consult neither
 * `c.get("actor")` nor anything derived from it. `/api/carts` and the rest of
 * `PUBLIC_ROUTES` in `interfaces/rest/route-coverage.ts` are NOT here: they are
 * public in the sense of needing no permission, and they still need the
 * organization the anonymous actor carries. Public and identity-free are
 * different properties and this list is the second one.
 */
export type IdentityFreeRoute = {
  method: string;
  path: string;
  justification: string;
};

export const IDENTITY_FREE_ROUTES: readonly IdentityFreeRoute[] = [
  {
    method: "GET",
    path: "/api/health",
    justification:
      "A liveness probe for load balancers; the handler issues its own SELECT 1 and reads no actor.",
  },
  {
    method: "GET",
    path: "/api/doc",
    justification:
      "The generated OpenAPI document is built from config and the route table, never from the caller.",
  },
  {
    method: "GET",
    path: "/api/doc-ext",
    justification:
      "The enriched OpenAPI document, same handler shape as /api/doc.",
  },
];

const DEFAULT_KEYS = new Set(
  IDENTITY_FREE_ROUTES.map((route) => `${route.method} ${route.path}`),
);

function normalize(entry: string): string {
  const [method = "", ...rest] = entry.trim().split(/\s+/);
  return `${method.toUpperCase()} ${rest.join(" ")}`;
}

/**
 * An app declares its own with `auth.identityFreeRoutes: ["POST /api/payments/notify"]`.
 *
 * Additive only: a config entry can never remove one of the defaults above, so
 * the narrowest thing an app can do to this set is widen it, and the widening
 * is visible in its own configuration file.
 *
 * The routes that want this are app-local by nature — a signed payment notify,
 * a tracked click-out — and they have no session, taking their organization
 * from the payload they verified rather than from a resolver, which is what
 * core's own `POST /api/payments/webhook/:provider` already does.
 *
 * WHAT AN ENTRY COSTS: `authMiddleware` is followed by the wrapper that opens
 * the plugin database scope FROM THE RESOLVED ACTOR. A route listed here gets
 * no actor, so it gets no scope, and every plugin read and write on that
 * request runs with no organization predicate while the handler still answers
 * normally. Such a route must open its own scope.
 */
export function isIdentityFreeRoute(
  method: string,
  path: string,
  config?: { auth?: { identityFreeRoutes?: readonly string[] } },
): boolean {
  const key = `${method.toUpperCase()} ${path}`;
  if (DEFAULT_KEYS.has(key)) return true;
  const declared = config?.auth?.identityFreeRoutes;
  if (!declared) return false;
  return declared.some((entry) => normalize(entry) === key);
}
