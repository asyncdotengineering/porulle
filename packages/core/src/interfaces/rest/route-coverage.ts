import type { RouterRoute } from "hono/types";
import { isRoutePermissionGuard } from "./utils.js";

export type PublicRoute = {
  method: string;
  path: string;
  justification: string;
};

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { method: "GET", path: "/api/health", justification: "Load balancers need an unauthenticated liveness probe." },
  { method: "GET", path: "/api/reference", justification: "The development API explorer is intentionally public when enabled." },
  { method: "GET", path: "/api/doc", justification: "The generated OpenAPI document is public when documentation exposure is enabled." },
  { method: "GET", path: "/api/doc-ext", justification: "The enriched OpenAPI document is public when documentation exposure is enabled." },
  { method: "POST", path: "/api/carts", justification: "Anonymous storefront shoppers create secret-backed guest carts." },
  { method: "GET", path: "/api/carts/:id", justification: "Guest cart reads require the cart secret; customer carts require ownership in the service." },
  { method: "POST", path: "/api/carts/:id/items", justification: "Anonymous storefront shoppers add items to a secret-backed guest cart." },
  { method: "PATCH", path: "/api/carts/:id/items/:itemId", justification: "Anonymous storefront shoppers change quantities in a secret-backed guest cart." },
  { method: "DELETE", path: "/api/carts/:id/items/:itemId", justification: "Anonymous storefront shoppers remove items from a secret-backed guest cart." },
  { method: "POST", path: "/api/checkout", justification: "Anonymous storefront checkout is authorized by the customer actor and cart/payment pipeline." },
  { method: "GET", path: "/api/media/:id", justification: "Public media assets redirect to their configured public storage URL; signed URLs still require an actor in the handler." },
  { method: "POST", path: "/api/promotions/validate", justification: "Storefront shoppers validate a promotion code before checkout; the route is rate-limited." },
  { method: "POST", path: "/api/payments/webhook", justification: "The payment provider authenticates this endpoint with its signed webhook payload." },
];

type RouteTableApp = {
  routes: readonly RouterRoute[];
};

type ComposedRouteHandler = {
  __COMPOSED_HANDLER?: unknown;
};

function hasPermissionGuard(handler: unknown, method?: string, seen = new Set<unknown>()): boolean {
  if (typeof handler !== "function" || seen.has(handler)) return false;
  seen.add(handler);
  if (isRoutePermissionGuard(handler, method)) return true;
  const composed = (handler as unknown as ComposedRouteHandler).__COMPOSED_HANDLER;
  return hasPermissionGuard(composed, method, seen);
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function pathPatternCovers(pattern: string, target: string): boolean {
  const patternParts = splitPath(pattern);
  const targetParts = splitPath(target);
  const wildcardIndex = patternParts.indexOf("*");
  if (wildcardIndex >= 0) {
    if (wildcardIndex !== patternParts.length - 1 || targetParts.length < wildcardIndex) return false;
  } else if (patternParts.length !== targetParts.length) {
    return false;
  }

  return patternParts.every((part, index) => {
    if (part === "*") return true;
    const targetPart = targetParts[index];
    return part.startsWith(":") || part === targetPart;
  });
}

function publicRouteCovers(route: RouterRoute): boolean {
  return PUBLIC_ROUTES.some((publicRoute) =>
    publicRoute.method === route.method && pathPatternCovers(publicRoute.path, route.path),
  );
}

function routeKey(route: RouterRoute): string {
  return `${route.method} ${route.path}`;
}

export function findUncoveredRoutes(app: RouteTableApp): string[] {
  const routes = app.routes;
  const guardedRoutes = routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.method === "ALL" && hasPermissionGuard(route.handler));
  const endpoints = new Map<string, { route: RouterRoute; index: number }>();

  for (const [index, route] of routes.entries()) {
    if (route.method === "ALL") continue;
    const key = routeKey(route);
    if (!endpoints.has(key)) endpoints.set(key, { route, index });
  }

  return [...endpoints.values()]
    .filter(({ route, index }) => {
      if (publicRouteCovers(route)) return false;
      const directlyGuarded = hasPermissionGuard(route.handler, route.method);
      const coveredByMiddleware = guardedRoutes.some(({ route: guard, index: guardIndex }) =>
        guardIndex <= index && pathPatternCovers(guard.path, route.path) && hasPermissionGuard(guard.handler, route.method),
      );
      return !directlyGuarded && !coveredByMiddleware;
    })
    .map(({ route }) => routeKey(route));
}

export function assertRouteCoverage(app: RouteTableApp): void {
  const uncovered = findUncoveredRoutes(app);
  if (uncovered.length > 0) {
    throw new Error(`Unclassified routes: ${uncovered.join(", ")}`);
  }
}
