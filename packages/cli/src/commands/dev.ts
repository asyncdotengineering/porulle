import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import consola from "consola";
import postgres from "postgres";

const DRIZZLE_CONFIG_CANDIDATES = [
  "drizzle.config.ts",
  "drizzle.config.mjs",
  "drizzle.config.cjs",
  "drizzle.config.js",
  "drizzle.config.json",
] as const;

export function loadDotenvFilesIfPresent(cwd: string): void {
  for (const name of [".env.local", ".env"] as const) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue;
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

export function isMissingUserTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  if (err.code === "42P01") return true;
  if (typeof err.message !== "string") return false;
  return err.message.includes('relation "user" does not exist');
}

function resolveDrizzleConfigFileName(cwd: string): string | undefined {
  for (const name of DRIZZLE_CONFIG_CANDIDATES) {
    if (existsSync(join(cwd, name))) return name;
  }
  return undefined;
}

function spawnCwdForDrizzleKit(projectCwd: string): string {
  let dir = projectCwd;
  for (;;) {
    if (existsSync(join(dir, "node_modules", "drizzle-orm"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cliPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const workspaceRoot = join(cliPackageRoot, "..", "..");
  const corePkg = join(workspaceRoot, "packages", "core");
  if (existsSync(join(corePkg, "node_modules", "drizzle-orm"))) {
    return corePkg;
  }
  return projectCwd;
}

export async function runDrizzleKitPush(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const configName = resolveDrizzleConfigFileName(cwd);
  if (!configName) {
    throw new Error(
      "No drizzle.config.ts (or .mjs/.js/.json) found — cannot bootstrap the database.",
    );
  }
  const configPath = join(cwd, configName);
  const spawnCwd = spawnCwdForDrizzleKit(cwd);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["drizzle-kit", "push", "--force", "--config", configPath],
      { cwd: spawnCwd, stdio: "inherit", shell: false, env },
    );
    proc.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`drizzle-kit push exited with code ${code ?? "unknown"}`),
        );
      }
    });
    proc.on("error", rejectPromise);
  });
}

export async function maybeBootstrapDevDatabase(options: {
  cwd: string;
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
}): Promise<void> {
  if (options.nodeEnv === "production") return;

  const databaseUrl = options.databaseUrl?.trim();
  if (!databaseUrl) return;

  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = postgres(databaseUrl, { max: 1 });
    await sql`SELECT 1 FROM "user" LIMIT 1`;
  } catch (error) {
    if (!isMissingUserTableError(error)) throw error;

    const configName = resolveDrizzleConfigFileName(options.cwd);
    if (!configName) {
      throw new Error(
        "Core auth tables are missing and no Drizzle config was found. Add drizzle.config.ts or run `bun run db:push`.",
      );
    }

    console.log(
      "⚠ Tables missing — running drizzle-kit push to bootstrap…",
    );
    if (sql) {
      await sql.end({ timeout: 5 });
      sql = undefined;
    }

    await runDrizzleKitPush(options.cwd, {
      ...process.env,
      DATABASE_URL: databaseUrl,
    });

    console.log("✓ Bootstrap complete. Starting dev server…");
    return;
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }
}

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Run local dev server with file watching",
  },
  args: {
    port: {
      type: "string",
      default: "3000",
    },
  },
  async run({ args }) {
    const port = String(args.port);
    consola.info(`Starting dev server on port ${port}`);

    loadDotenvFilesIfPresent(process.cwd());

    try {
      await maybeBootstrapDevDatabase({
        cwd: process.cwd(),
        nodeEnv: process.env.NODE_ENV,
        databaseUrl: process.env.DATABASE_URL,
      });
    } catch (error) {
      consola.error(error);
      consola.error(
        "Try `bun run db:push` manually or check your DATABASE_URL.",
      );
      process.exit(1);
    }

    const proc = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "watch", "src/dev-server.ts", "--port", port],
      {
        stdio: "inherit",
        shell: false,
      },
    );

    await new Promise<void>((resolvePromise, rejectPromise) => {
      proc.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`dev exited with code ${code}`));
      });
      proc.on("error", rejectPromise);
    });
  },
});
