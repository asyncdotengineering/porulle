import { defineCommand } from "citty";
import { resolve, join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

/** Scope definition from the commerce config */
interface ScopeDef {
  prefix: string;
  description: string;
  permissions: Record<string, string[]>;
  rateLimit?: { maxRequests: number; timeWindow: number };
}

interface AuthApi {
  createApiKey: (input: { body: Record<string, unknown> }) => Promise<{ key: string; id: string }>;
  [key: string]: unknown;
}

interface EngineResult {
  config: {
    auth?: {
      apiKeyScopes?: Record<string, ScopeDef>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  auth: { api: AuthApi };
  app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  kernel: Record<string, unknown>;
}

/**
 * Boots the commerce engine in-process and returns the auth instance.
 * Uses dynamic import to avoid compile-time dependency on @porulle/core.
 */
async function bootEngine(configPath: string): Promise<EngineResult> {
  const absPath = resolve(process.cwd(), configPath);
  const configModule = await import(absPath);
  const config = await configModule.default;

  // Dynamic import — resolved at runtime from the consumer's node_modules
  const corePkg = "@porulle/core";
  const { createServer } = await import(/* webpackIgnore: true */ corePkg) as {
    createServer: (config: unknown) => Promise<{ app: EngineResult["app"]; kernel: Record<string, unknown> }>;
  };
  const { app, kernel } = await createServer(config);

  const auth = (kernel as Record<string, unknown>).auth as { api: AuthApi };

  return { config, auth, app, kernel };
}

/**
 * Finds or creates an admin user for key ownership.
 */
async function findOrCreateAdminUser(
  app: { request: (url: string, init?: RequestInit) => Promise<Response> },
  config: Record<string, unknown>,
): Promise<string> {
  // Try to create an admin user via the auth API
  const email = "admin@local.dev";
  const password = "admin-setup-" + Date.now();

  const res = await app.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email, password, name: "Admin" }),
  });

  if (res.ok) {
    const data = (await res.json()) as { user?: { id?: string } };
    if (data?.user?.id) return data.user.id;
  }

  // If signup fails (user exists), try sign-in
  const signInRes = await app.request(
    "http://localhost/api/auth/sign-in/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ email, password }),
    },
  );

  if (signInRes.ok) {
    const data = (await signInRes.json()) as { user?: { id?: string } };
    if (data?.user?.id) return data.user.id;
  }

  throw new Error(
    "Could not find or create an admin user. Create one first via /api/auth/sign-up/email",
  );
}

export const apiKeyCreateCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create an API key for a predefined scope",
  },
  args: {
    scope: {
      type: "string",
      description: "Scope name (defined in commerce.config.ts auth.apiKeyScopes)",
      required: true,
    },
    config: {
      type: "string",
      description: "Path to commerce.config.ts",
      default: "./commerce.config.ts",
    },
    name: {
      type: "string",
      description: "Key name (default: scope name)",
    },
    "save-env": {
      type: "boolean",
      description: "Save key to .env.local",
      default: false,
    },
    "env-var": {
      type: "string",
      description: "Env variable name (used with --save-env)",
    },
  },
  async run({ args }) {
    const { config, auth, app } = await bootEngine(args.config);

    const scopes = config.auth?.apiKeyScopes;
    if (!scopes || Object.keys(scopes).length === 0) {
      console.error("No apiKeyScopes defined in commerce.config.ts");
      console.error("");
      console.error("Add scopes to your config:");
      console.error("  auth: {");
      console.error("    apiKeyScopes: {");
      console.error('      storefront: { prefix: "uc_pub_", permissions: { catalog: ["read"] }, ... }');
      console.error("    }");
      console.error("  }");
      process.exit(1);
    }

    const scopeDef = scopes[args.scope];
    if (!scopeDef) {
      console.error(`Unknown scope: "${args.scope}"`);
      console.error("");
      console.error("Available scopes:");
      for (const [name, def] of Object.entries(scopes)) {
        console.error(`  ${name} — ${def.description}`);
      }
      process.exit(1);
    }

    console.log(`Creating ${args.scope} API key...`);

    // Find or create an admin user for key ownership
    const userId = await findOrCreateAdminUser(app, config);

    const result = await auth.api.createApiKey({
      body: {
        configId: args.scope,
        userId,
        name: args.name ?? `${args.scope}-key`,
        permissions: scopeDef.permissions,
        ...(scopeDef.rateLimit
          ? {
              rateLimitEnabled: true,
              rateLimitMax: scopeDef.rateLimit.maxRequests,
              rateLimitTimeWindow: scopeDef.rateLimit.timeWindow,
            }
          : {}),
      },
    });

    console.log("");
    console.log(`  Scope:       ${args.scope}`);
    console.log(`  Description: ${scopeDef.description}`);
    console.log(`  Prefix:      ${scopeDef.prefix}`);
    console.log(`  Key:         ${result.key}`);
    console.log(`  ID:          ${result.id}`);
    console.log("");
    console.log("  Permissions:");
    for (const [resource, actions] of Object.entries(scopeDef.permissions)) {
      console.log(`    ${resource}: ${(actions as string[]).join(", ")}`);
    }
    if (scopeDef.rateLimit) {
      console.log(`  Rate limit:  ${scopeDef.rateLimit.maxRequests} req / ${scopeDef.rateLimit.timeWindow}ms`);
    }

    if (args["save-env"]) {
      const envFile = join(process.cwd(), ".env.local");
      const varName = args["env-var"] ?? `UC_${args.scope.toUpperCase().replace(/-/g, "_")}_KEY`;
      const line = `${varName}=${result.key}`;

      if (existsSync(envFile)) {
        const existing = readFileSync(envFile, "utf-8");
        if (existing.includes(varName + "=")) {
          // Replace existing
          const updated = existing.replace(
            new RegExp(`^${varName}=.*$`, "m"),
            line,
          );
          writeFileSync(envFile, updated);
        } else {
          writeFileSync(envFile, existing.trimEnd() + "\n" + line + "\n");
        }
      } else {
        writeFileSync(envFile, line + "\n");
      }
      console.log(`  Saved to:    .env.local as ${varName}`);
    }

    console.log("");
    console.log("This is the only time the full key is shown. Store it securely.");

    process.exit(0);
  },
});

export const apiKeyListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List existing API keys",
  },
  args: {
    config: {
      type: "string",
      description: "Path to commerce.config.ts",
      default: "./commerce.config.ts",
    },
  },
  async run({ args }) {
    const { config } = await bootEngine(args.config);

    const scopes = config.auth?.apiKeyScopes ?? {};
    console.log("Defined API key scopes:");
    console.log("");
    for (const [name, def] of Object.entries(scopes)) {
      console.log(`  ${name}`);
      console.log(`    ${def.description}`);
      console.log(`    Prefix: ${def.prefix}`);
      console.log(`    Permissions: ${Object.entries(def.permissions).map(([r, a]) => `${r}:${(a as string[]).join(",")}`).join(" | ")}`);
      if (def.rateLimit) {
        console.log(`    Rate limit: ${def.rateLimit.maxRequests} req / ${def.rateLimit.timeWindow}ms`);
      }
      console.log("");
    }

    process.exit(0);
  },
});

export const apiKeyCommand = defineCommand({
  meta: {
    name: "api-key",
    description: "Manage API keys (create, list)",
  },
  subCommands: {
    create: apiKeyCreateCommand,
    list: apiKeyListCommand,
  },
});
