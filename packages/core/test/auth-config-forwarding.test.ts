import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import type { AuthConfig } from "../src/config/types.js";
import { createAuth } from "../src/auth/setup.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

/**
 * Every option in `config.auth.password` and `config.auth.extend` must actually
 * REACH better-auth.
 *
 * This suite exists because the failure it guards against is invisible by
 * construction: until 2026-09-20 core built its `emailAndPassword` block from a
 * fixed list and dropped 9 of better-auth 1.7.1's 14 options, so a consumer
 * could set `revokeSessionsOnPasswordReset: true`, typecheck clean, read the
 * line back as a security decision, and have nothing happen. No gate could see
 * it. Assertions here read the OPTIONS OBJECT better-auth was actually handed.
 */

async function optionsFor(auth: AuthConfig) {
  const pg = new PGlite();
  // No schema and no pushSchema: these rows read the OPTIONS OBJECT handed to
  // better-auth, never the database, so a bare handle is the honest fixture.
  const db = drizzle(pg) as unknown as DatabaseAdapter["db"];
  const adapter: DatabaseAdapter = {
    provider: "postgresql",
    db,
    transaction: async (fn) => fn(db),
  };
  const config = await createTestConfig({ databaseAdapter: adapter, auth });
  const instance = createAuth(adapter, config);
  const options = (instance as unknown as { options: Record<string, unknown> }).options;
  return {
    emailAndPassword: options.emailAndPassword as Record<string, unknown>,
    options,
    cleanup: () => pg.close(),
  };
}

describe("auth config forwarding", () => {
  it("revokes other sessions on password reset BY DEFAULT, against better-auth's own false", async () => {
    const { emailAndPassword, cleanup } = await optionsFor({});
    expect(emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
    await cleanup();
  });

  it("honours an explicit opt-out — the row a hardcoded `true` would fail", async () => {
    const { emailAndPassword, cleanup } = await optionsFor({
      password: { revokeSessionsOnPasswordReset: false },
    });
    expect(emailAndPassword.revokeSessionsOnPasswordReset).toBe(false);
    await cleanup();
  });

  it("forwards a configured password length", async () => {
    const { emailAndPassword, cleanup } = await optionsFor({
      password: { minLength: 12, maxLength: 64 },
    });
    expect(emailAndPassword.minPasswordLength).toBe(12);
    expect(emailAndPassword.maxPasswordLength).toBe(64);
    await cleanup();
  });

  it("OMITS an unconfigured option rather than sending undefined, so better-auth's own default applies", async () => {
    const { emailAndPassword, cleanup } = await optionsFor({});
    expect("minPasswordLength" in emailAndPassword).toBe(false);
    expect("resetPasswordTokenExpiresIn" in emailAndPassword).toBe(false);
    await cleanup();
  });

  it("forwards a reset-token lifetime and an audit hook", async () => {
    const seen: string[] = [];
    const { emailAndPassword, cleanup } = await optionsFor({
      password: {
        resetTokenExpiresIn: 900,
        onPasswordReset: async ({ user }) => {
          seen.push(user.id);
        },
      },
    });
    expect(emailAndPassword.resetPasswordTokenExpiresIn).toBe(900);
    expect(typeof emailAndPassword.onPasswordReset).toBe("function");
    await cleanup();
  });

  it("passes `extend` through to better-auth", async () => {
    const { options, cleanup } = await optionsFor({
      extend: { appName: "forwarding-probe" },
    });
    expect(options.appName).toBe("forwarding-probe");
    await cleanup();
  });

  it("never lets `extend` clobber a key core owns", async () => {
    const { emailAndPassword, cleanup } = await optionsFor({
      // @ts-expect-error `emailAndPassword` is Omitted from AuthConfig["extend"]
      // precisely so this is a COMPILE error and not a silent override. The cast
      // proves core still wins at RUNTIME for anyone who reaches it via `as`.
      extend: { emailAndPassword: { enabled: false } },
    });
    expect(emailAndPassword.enabled).toBe(true);
    await cleanup();
  });
});
