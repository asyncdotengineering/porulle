/**
 * Integration test utilities for REST API endpoints.
 *
 * Provides helper functions to test Hono routes with a real kernel,
 * PGlite database, and authentication middleware.
 */

import { Hono } from "hono";
import { createKernel } from "../runtime/kernel.js";
import { createAuth } from "../auth/setup.js";
import { authMiddleware } from "../auth/middleware.js";
import { createRestRoutes } from "../interfaces/rest/index.js";
import { createPGliteTestConfig } from "./create-test-config.js";
import { CommerceValidationError } from "../kernel/errors.js";
import { Ok, Err } from "../kernel/result.js";
import type { CommerceConfig } from "../config/types.js";
import type { Actor } from "../auth/types.js";
import type { AuthInstance } from "../auth/setup.js";

type ServerEnv = {
  Variables: {
    auth: AuthInstance;
    actor: Actor | null;
  };
};

const mockPaymentAdapter = {
  providerId: "test-payments",
  async createPaymentIntent(params: { amount: number; currency: string }) {
    return Ok({
      id: "pi_test_" + Date.now(),
      status: "requires_capture",
      amount: params.amount,
      currency: params.currency,
      clientSecret: "secret_test",
    });
  },
  async capturePayment() {
    return Ok({ id: "pi_test_" + Date.now(), status: "succeeded", amountCaptured: 1000 });
  },
  async refundPayment() {
    return Ok({ id: "re_test_" + Date.now(), status: "succeeded", amountRefunded: 1000 });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook(request: Request) {
    // Extract signature from headers
    const signature = request.headers.get("stripe-signature") || request.headers.get("webhook-signature");

    // Extract payload from request body
    let payload: Record<string, unknown> | undefined;
    try {
      payload = await request.clone().json();
    } catch {
      return Err(new CommerceValidationError("Webhook payload is invalid or missing"));
    }

    // Simulate signature verification for production-hardened testing
    // Reject invalid signatures like "invalid_signature"
    if (signature === "invalid_signature") {
      return Err(new CommerceValidationError("Invalid webhook signature"));
    }

    // Reject requests with no required fields
    if (!payload || !payload.type) {
      return Err(new CommerceValidationError("Webhook payload is missing required fields"));
    }

    return Ok({ id: "evt_test_" + Date.now(), type: String(payload.type), data: (payload.data ?? {}) as unknown });
  },
};

/**
 * Creates a test server with PGlite-backed kernel for REST API testing.
 */
export async function createTestServer(
  overrides: Partial<CommerceConfig> = {},
): Promise<{
  server: Hono<ServerEnv>;
  kernel: ReturnType<typeof createKernel>;
  auth: AuthInstance;
  cleanup: () => Promise<void>;
}> {
  const { config, cleanup } = await createPGliteTestConfig({
    payments: [mockPaymentAdapter],
    ...overrides,
  });

  const kernel = createKernel(config);
  const auth = createAuth(kernel.database, config);
  const app = new Hono<ServerEnv>();

  // Set auth in context (like createServer does)
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });

  // Test middleware: allow direct actor injection via x-test-actor header for testing
  app.use("*", async (c, next) => {
    const testActorHeader = c.req.header("x-test-actor");
    if (testActorHeader) {
      try {
        const actor = JSON.parse(testActorHeader) as Actor;
        c.set("actor", actor);
        await next();
        return;
      } catch {
        // Invalid JSON, continue to auth middleware
      }
    }
    await next();
  });

  // Add auth middleware
  app.use("*", authMiddleware(auth, config));

  // Error handling middleware - catch thrown errors and convert to JSON
  app.use("*", async (c, next) => {
    try {
      await next();
    } catch (error) {
      // Import error handling utilities
      const { mapErrorToResponse, mapErrorToStatus } = await import("../interfaces/rest/utils.js");
      return c.json(
        mapErrorToResponse(error),
        mapErrorToStatus(error),
      );
    }
  });

  // Add REST routes
  app.route("/api", createRestRoutes(kernel));

  return { server: app, kernel, auth, cleanup };
}

/**
 * Helper to parse JSON response from Hono Response
 */
export async function parseJsonResponse<T = unknown>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

/**
 * Common test actor with staff permissions
 */
export const testActor: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-000000000001",
  email: "test@example.com",
  name: "Test Staff",
  vendorId: null,
  organizationId: "org_default",
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "inventory:adjust",
    "inventory:read",
    "orders:create",
    "orders:read",
    "orders:update",
    "cart:create",
    "cart:update",
    "cart:read",
    "cart:manage",
    "customers:update:self",
    "webhooks:manage",
    "pricing:manage",
    "shipping:manage",
    "tax:manage",
    "staff:manage",
    "promotions:manage",
    "promotions:read",
    "audit:read",
    "media:write",
    "compensation:admin",
  ],
};

/**
 * Test actor with read-only permissions
 */
export const readonlyActor: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-000000000002",
  email: "readonly@example.com",
  name: "Read Only User",
  vendorId: null,
  organizationId: "org_default",
  role: "customer",
  permissions: ["catalog:read", "cart:read", "orders:read:own"],
};

/**
 * Test actor with no permissions
 */
export const noPermActor: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-000000000003",
  email: "noperm@example.com",
  name: "No Perm",
  vendorId: null,
  organizationId: "org_default",
  role: "customer",
  permissions: [],
};

/**
 * Helper to create a mock request with actor context
 */
export function createMockRequest(server: Hono<ServerEnv>, options: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  actor?: Actor;
}) {
  const url = new URL(options.url, "http://localhost");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };

  // Add actor as header for test middleware
  if (options.actor) {
    headers["x-test-actor"] = JSON.stringify(options.actor);
  }

  // Build the request
  const requestInit: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.body) {
    requestInit.body = JSON.stringify(options.body);
  }
  const request = new Request(url, requestInit);

  return request;
}

/**
 * Helper to make authenticated requests to the test server
 */
export async function makeRequest(
  server: Hono<ServerEnv>,
  options: {
    method: string;
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
    actor?: Actor;
  },
) {
  // Create request with actor header (defaults to testActor)
  const request = createMockRequest(server, {
    ...options,
    actor: options.actor ?? testActor,
  });

  // Route the request through Hono
  const response = await server.fetch(request);

  return response;
}
