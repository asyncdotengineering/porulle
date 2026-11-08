/**
 * Consumer-owned Better Auth plugins (e.g. @better-auth/mcp) need extra Drizzle
 * tables, jwt() options, and suppressed paths — all wired through commerce config.
 */

import { describe, expect, it, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { mcp } from "@better-auth/mcp";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import { createAuth } from "../src/auth/setup.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import {
  buildAuthSchemaGuardOptions,
  findAuthSchemaParityMismatches,
} from "../src/auth/auth-schema-guard.js";
import { pushSchema } from "../src/kernel/database/migrate.js";
import * as fullSchema from "../src/kernel/database/schema.js";
import * as oauthPluginAuthSchema from "./fixtures/oauth-plugin-auth-schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

const MCP_RESOURCE = "https://example.test/mcp";

function mcpPlugin() {
  return mcp({
    loginPage: "/sign-in",
    consentPage: "/consent",
    resource: MCP_RESOURCE,
    allowDynamicClientRegistration: true,
  });
}

const oauthSchemaRecord = oauthPluginAuthSchema as Record<string, unknown>;

describe("auth oauth plugin extension points", () => {
  let pg: PGlite;

  afterAll(async () => {
    await pg?.close();
  });

  it("declares oauth provider tables when mcp is in the guard plugin set", () => {
    const mismatches = findAuthSchemaParityMismatches(
      buildAuthSchemaGuardOptions({
        jwt: { disableSettingJwtHeader: true },
        extraAuthPlugins: [mcpPlugin()],
      }),
      oauthSchemaRecord,
    );
    expect(mismatches).toEqual([]);
  });

  it("forwards jwt options and mounts oauth registration on a live better-auth instance", async () => {
    pg = new PGlite();
    const db = drizzle(pg, { schema: fullSchema }) as DrizzleDatabase;

    const adapter: DatabaseAdapter = {
      provider: "postgresql",
      db,
      transaction: async (fn) => fn(db),
    };

    const config = await createTestConfig({
      databaseAdapter: adapter,
      auth: {
        baseURL: "http://localhost:3000",
        jwt: { disableSettingJwtHeader: true },
        suppressedAuthPaths: ["/token"],
        extraAuthSchema: oauthSchemaRecord,
        extraAuthPlugins: [mcpPlugin()],
      },
    });

    await pushSchema(db, config);

    const auth = createAuth(adapter, config);
    const options = (auth as unknown as { options: Record<string, unknown> }).options;
    const jwtPlugin = (
      options.plugins as Array<{ id?: string; options?: { disableSettingJwtHeader?: boolean } }>
    ).find((plugin) => plugin.id === "jwt");
    expect(jwtPlugin?.options?.disableSettingJwtHeader).toBe(true);
    expect(options.disabledPaths).toContain("/token");

    const endpointPaths = new Set(
      Object.values(auth.api)
        .map((endpoint) => (endpoint as { path?: string }).path)
        .filter((path): path is string => typeof path === "string"),
    );
    expect(endpointPaths.has("/oauth2/register")).toBe(true);

    const metadata = await auth.handler(
      new Request("http://localhost:3000/api/auth/.well-known/oauth-authorization-server"),
    );
    expect(metadata.status).toBe(200);
    const body = (await metadata.json()) as { registration_endpoint?: string };
    expect(body.registration_endpoint).toContain("/oauth2/register");
  });
});
