import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import {
  maybeBootstrapDevDatabase,
  runDrizzleKitPush,
} from "../src/commands/dev.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const authSchemaTs = join(repoRoot, "packages/core/src/auth/auth-schema.ts");
const kernelSchemaTs = join(
  repoRoot,
  "packages/core/src/kernel/database/schema.ts",
);

async function createPgliteTcp(): Promise<{
  databaseUrl: string;
  cleanup: () => Promise<void>;
}> {
  const db = new PGlite();
  const server = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 32,
  });
  await server.start();
  const port = (server as unknown as { port: number }).port;
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  return {
    databaseUrl,
    cleanup: async () => {
      await server.stop();
      await db.close();
    },
  };
}

async function writeMinimalDrizzleConfig(projectDir: string): Promise<void> {
  const contents = `"use strict";

module.exports = {
  dialect: "postgresql",
  schema: [
    ${JSON.stringify(authSchemaTs)},
    ${JSON.stringify(kernelSchemaTs)},
  ],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
};
`;
  await writeFile(join(projectDir, "drizzle.config.cjs"), contents, "utf8");
}

describe("maybeBootstrapDevDatabase (PGlite)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "uc-dev-bootstrap-"));
    await writeMinimalDrizzleConfig(projectDir);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it(
    "bootstraps when user table is missing then leaves schema in place",
    { timeout: 120_000 },
    async () => {
      if (!existsSync(authSchemaTs) || !existsSync(kernelSchemaTs)) {
        throw new Error("packages/core schema sources missing.");
      }

      const { databaseUrl, cleanup } = await createPgliteTcp();
      try {
        await maybeBootstrapDevDatabase({
          cwd: projectDir,
          nodeEnv: "development",
          databaseUrl,
        });

        const sql = postgres(databaseUrl, { max: 1 });
        try {
          await sql`SELECT 1 FROM "user" LIMIT 1`;
        } finally {
          await sql.end({ timeout: 5 });
        }

        await maybeBootstrapDevDatabase({
          cwd: projectDir,
          nodeEnv: "development",
          databaseUrl,
        });
      } finally {
        await cleanup();
      }
    },
  );

  it(
    "skips bootstrap when NODE_ENV is production even if user table is missing",
    { timeout: 60_000 },
    async () => {
      if (!existsSync(authSchemaTs) || !existsSync(kernelSchemaTs)) {
        throw new Error("packages/core schema sources missing.");
      }

      const { databaseUrl, cleanup } = await createPgliteTcp();
      try {
        await maybeBootstrapDevDatabase({
          cwd: projectDir,
          nodeEnv: "production",
          databaseUrl,
        });

        const sql = postgres(databaseUrl, { max: 1 });
        try {
          await expect(sql`SELECT 1 FROM "user" LIMIT 1`).rejects.toMatchObject(
            { code: "42P01" },
          );
        } finally {
          await sql.end({ timeout: 5 });
        }
      } finally {
        await cleanup();
      }
    },
  );

  it(
    "does not invoke drizzle-kit push when tables already exist",
    { timeout: 120_000 },
    async () => {
      if (!existsSync(authSchemaTs) || !existsSync(kernelSchemaTs)) {
        throw new Error("packages/core schema sources missing.");
      }

      const { databaseUrl, cleanup } = await createPgliteTcp();
      try {
        await runDrizzleKitPush(projectDir, {
          ...process.env,
          DATABASE_URL: databaseUrl,
        });

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        await maybeBootstrapDevDatabase({
          cwd: projectDir,
          nodeEnv: "development",
          databaseUrl,
        });

        const joined = logSpy.mock.calls.map((c) => String(c.join(" "))).join("\n");
        expect(joined).not.toContain("Tables missing");

        logSpy.mockRestore();
      } finally {
        await cleanup();
      }
    },
  );
});
