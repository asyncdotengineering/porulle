import { defineConfig, type DatabaseAdapter } from "@porulle/core";
import { stripePayment } from "@porulle/adapter-stripe";
import { agentCatalogRoutes } from "./src/agent-routes.js";

export interface OriginConfigEnv {
  DATABASE_URL: string;
  PUBLIC_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export function createOriginConfig(env: OriginConfigEnv, databaseAdapter: DatabaseAdapter) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is required");
  return defineConfig({
    storeName: "Kuralle Agentic Commerce",
    version: "0.1.0",
    database: { provider: "postgresql" },
    databaseAdapter,
    auth: {
      baseURL: env.PUBLIC_URL,
      requireEmailVerification: true,
      defaultOrganizationId: "org_default",
      trustedOrigins: [env.PUBLIC_URL],
      apiKeys: {
        enabled: true,
        defaultPermissions: [
          "catalog:read",
          "cart:create",
          "cart:read",
          "cart:update",
          "orders:create",
          "orders:read",
        ],
      },
      apiKeyScopes: {
        agent_storefront: {
          prefix: "por_agent_",
          description: "Server-side agent access to product, cart, checkout, and order APIs",
          permissions: {
            catalog: ["read"],
            cart: ["create", "read", "update"],
            orders: ["create", "read"],
          },
          rateLimit: { maxRequests: 300, timeWindow: 60_000 },
        },
      },
    },
    payments: [stripePayment({
      secretKey: env.STRIPE_SECRET_KEY,
      ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
    })],
    shipping: { type: "flat", flatRate: 0, brackets: [], fallbackCost: 0 },
    rateLimits: { api: 300, auth: 20, checkout: 30 },
    jobs: { autorun: { enabled: false } },
    runtime: { getClientIp: (context) => context.req.header("cf-connecting-ip") ?? "unknown" },
    exposeOpenApiSpec: env.PUBLIC_URL.includes("localhost"),
    routes: (app, kernel) => agentCatalogRoutes(app, kernel),
  });
}
