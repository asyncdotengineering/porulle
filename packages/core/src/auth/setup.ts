import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { Role } from "better-auth/plugins/access";
import { apiKey } from "@better-auth/api-key";
import { organization, twoFactor, phoneNumber, jwt, bearer } from "better-auth/plugins";
import type { CommerceConfig } from "../config/types.js";
import type { DatabaseAdapter } from "../kernel/database/adapter.js";
import * as authSchema from "./auth-schema.js";

type BetterAuthDbProvider = "pg" | "mysql" | "sqlite";

function resolveAuthDbProvider(provider: string): BetterAuthDbProvider {
  if (provider === "postgres" || provider === "postgresql" || provider === "pg") return "pg";
  if (provider === "mysql") return "mysql";
  if (provider === "sqlite") return "sqlite";
  throw new Error(`Unsupported auth database provider "${provider}".`);
}

interface AuthEmailPayload {
  user: { email: string; name: string | null };
  url: string;
}

/**
 * The auth type is inferred from `typeof betterAuth(...)` with all plugins enabled.
 * This gives us the full API surface without manual interface maintenance.
 *
 * We use a type-level-only reference (never executed) to capture the complete type.
 */
type FullBetterAuth = ReturnType<typeof betterAuth<{
  plugins: [
    ReturnType<typeof organization>,
    ReturnType<typeof bearer>,
    ReturnType<typeof jwt>,
    ReturnType<typeof twoFactor>,
    ReturnType<typeof apiKey>,
    ReturnType<typeof phoneNumber>,
  ];
}>>;

/**
 * AuthInstance — inferred from Better Auth with all plugins.
 * No manual type maintenance needed.
 */
export type AuthInstance = FullBetterAuth;

export function createAuth(
  db: DatabaseAdapter,
  config: CommerceConfig,
): AuthInstance {
  if (
    process.env.NODE_ENV === "production" &&
    config.auth?.requireEmailVerification === false
  ) {
    console.warn(
      "auth.requireEmailVerification is FALSE in production — anyone can sign up with any email and access the account immediately. Set to true and configure config.email.send for production storefronts.",
    );
  }

  const plugins: Array<
    | ReturnType<typeof organization>
    | ReturnType<typeof twoFactor>
    | ReturnType<typeof apiKey>
    | ReturnType<typeof phoneNumber>
    | ReturnType<typeof jwt>
    | ReturnType<typeof bearer>
  > = [
    organization({
      roles: (config.auth?.roles ?? {}) as unknown as Record<string, Role | undefined>,
    }),
    bearer(),
    jwt(),
  ];

  if (config.auth?.twoFactor?.enabled) {
    plugins.push(twoFactor({ issuer: config.storeName ?? "UnifiedCommerce" }));
  }

  const scopes = config.auth?.apiKeyScopes;
  if (scopes && Object.keys(scopes).length > 0) {
    const apiKeyConfigs = Object.entries(scopes).map(([scopeId, scope]) => ({
      configId: scopeId,
      defaultPrefix: scope.prefix,
      ...(scope.rateLimit
        ? {
            rateLimit: {
              enabled: true,
              maxRequests: scope.rateLimit.maxRequests,
              timeWindow: scope.rateLimit.timeWindow,
            },
          }
        : {}),
      ...(scope.keyExpiration ? { keyExpiration: scope.keyExpiration } : {}),
    }));
    plugins.push(apiKey(apiKeyConfigs));
  } else if (config.auth?.apiKeys?.enabled) {
    plugins.push(apiKey());
  }

  if (config.auth?.phoneAuth) {
    plugins.push(phoneNumber({
      sendOTP: config.auth.phoneAuth.sendOTP,
      verifyOTP: config.auth.phoneAuth.verifyOTP,
      otpLength: config.auth.phoneAuth.otpLength ?? 6,
      expiresIn: config.auth.phoneAuth.expiresIn ?? 300,
      signUpOnVerification: config.auth.phoneAuth.signUpOnVerification ?? {
        getTempEmail: (phone: string) => `${phone.replace(/\+/g, "")}@phone.local`,
      },
    }));
  }

  // Inject extra Better Auth plugins from config (e.g., @better-auth/expo)
  if (config.auth?.extraAuthPlugins?.length) {
    plugins.push(...(config.auth.extraAuthPlugins as typeof plugins[number][]));
  }

  try {
    const auth = betterAuth({
      database: drizzleAdapter(db.db as unknown as Record<string, unknown>, {
        provider: resolveAuthDbProvider(db.provider),
        schema: authSchema,
      }),
      // Customer profile creation is handled lazily by CustomerService.getByUserId()
      // which calls getOrCreateByUserId() on first access (checkout, /api/me/profile).
      // No databaseHook needed — admins/staff who sign up don't need customer profiles.
      trustedOrigins: config.auth?.trustedOrigins ?? [],
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: config.auth?.requireEmailVerification ?? true,
        sendResetPassword: async ({ user, url }: AuthEmailPayload) => {
          if (!config.email) return;
          await config.email.send({
            template: "password-reset",
            to: user.email,
            data: { resetUrl: url, userName: user.name },
          });
        },
        sendVerificationEmail: async ({ user, url }: AuthEmailPayload) => {
          if (!config.email) return;
          await config.email.send({
            template: "email-verification",
            to: user.email,
            data: { verifyUrl: url, userName: user.name },
          });
        },
      },
      socialProviders: config.auth?.socialProviders ?? {},
      session: {
        expiresIn: config.auth?.sessionDuration ?? 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
        cookieCache: {
          enabled: true,
          maxAge: 60 * 5,
        },
      },
      advanced: {
        cookiePrefix: "uc",
        useSecureCookies: process.env.NODE_ENV === "production",
        // VAPT r2 (pi) finding: SameSite was never set anywhere. Without it,
        // browsers default to Lax for new cookies, but the explicit setting
        // is required for predictable cross-browser behavior and to satisfy
        // PCI-DSS 4.0.1 cookie hygiene. Lax is the right default for a
        // commerce session: blocks CSRF on POST/PUT/DELETE while still
        // allowing top-level GET navigation (needed for OAuth redirects).
        defaultCookieAttributes: {
          sameSite: "lax",
        },
      },
      plugins,
      user: {
        additionalFields: {
          vendorId: { type: "string", required: false },
          posOperatorPin: { type: "string", required: false },
        },
      },
    });

    // The runtime return matches FullBetterAuth structurally — plugins may differ
    // at runtime (conditional) but the API surface is a superset.
    return auth as unknown as AuthInstance;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown better-auth initialization error.";
    throw new Error(`Failed to initialize authentication: ${message}`);
  }
}
