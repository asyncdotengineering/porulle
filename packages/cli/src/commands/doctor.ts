import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineCommand } from "citty";
import postgres from "postgres";
import { readJson } from "../utils.js";

type Status = "ok" | "warn" | "fail" | "info";

interface Line {
  status: Status;
  text: string;
}

const CLI_ROOT = dirname(fileURLToPath(import.meta.url));

function normalizeProjectRel(cwd: string, projectRel: string): string {
  const stripped = projectRel.startsWith("./") ? projectRel.slice(2) : projectRel;
  return resolve(cwd, stripped);
}

function walkFiles(dir: string, visit: (abs: string) => void): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkFiles(abs, visit);
    else visit(abs);
  }
}

function extractBracketArrayBody(src: string, key: string): string | null {
  const needle = `${key}:`;
  const keyIdx = src.indexOf(needle);
  if (keyIdx === -1) return null;
  const bracketIdx = src.indexOf("[", keyIdx);
  if (bracketIdx === -1) return null;
  let depth = 0;
  for (let i = bracketIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return src.slice(bracketIdx + 1, i);
    }
  }
  return null;
}

function parseImportBindings(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRe =
    /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/gs;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    const named = m[1];
    const defaultImport = m[2];
    const from = m[3];
    if (!from) continue;
    if (defaultImport) map.set(defaultImport, from);
    if (named) {
      for (const part of named.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const withoutType = trimmed.replace(/^type\s+/, "");
        const rawName = withoutType.split(/\s+as\s+/)[0];
        const name = rawName?.trim() ?? "";
        if (name) map.set(name, from);
      }
    }
  }
  return map;
}

function extractSchemaIdentifiers(schemaBody: string): string[] {
  const ids: string[] = [];
  const objRe = /\{\s*([^}]+?)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(schemaBody)) !== null) {
    const inner = m[1];
    if (!inner) continue;
    for (const part of inner.split(",")) {
      const tok = part.trim().split(/\s+/)[0];
      if (tok && /^[a-zA-Z_$]/.test(tok)) ids.push(tok);
    }
  }
  return ids;
}

function extractPluginCallerIds(pluginsBody: string): string[] {
  const ids: string[] = [];
  const callRe = /(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(pluginsBody)) !== null) {
    const id = m[1];
    if (!id || id === "if" || id === "switch" || id === "require") continue;
    ids.push(id);
  }
  return [...new Set(ids)];
}

function resolveLocalModulePath(commerceDir: string, specifier: string): string {
  const base = specifier.startsWith("./") || specifier.startsWith("../") ? specifier : `./${specifier}`;
  const withoutJs = base.replace(/\.js$/i, ".ts");
  const tsCandidate = resolve(commerceDir, withoutJs);
  const jsCandidate = resolve(commerceDir, base);
  if (existsSync(tsCandidate)) return tsCandidate;
  if (existsSync(jsCandidate)) return jsCandidate;
  return tsCandidate;
}

function expandDrizzlePatterns(patterns: readonly string[], cwd: string): Set<string> {
  const out = new Set<string>();

  for (const raw of patterns) {
    const pat = raw.replace(/\\/g, "/");

    if (!pat.includes("*")) {
      const abs = normalizeProjectRel(cwd, pat);
      if (existsSync(abs)) out.add(abs);
      continue;
    }

    const pluginGlob =
      pat === "./node_modules/@porulle/plugin-*/src/schema.ts" ||
      pat === "node_modules/@porulle/plugin-*/src/schema.ts";

    if (pluginGlob) {
      const base = join(cwd, "node_modules/@porulle");
      if (existsSync(base)) {
        for (const name of readdirSync(base)) {
          if (!name.startsWith("plugin-")) continue;
          const file = join(base, name, "src/schema.ts");
          if (existsSync(file)) out.add(file);
        }
      }
      continue;
    }

    const starStarIdx = pat.indexOf("/**/");
    if (starStarIdx !== -1) {
      const prefixRaw = pat.slice(0, starStarIdx).replace(/^\.\//, "");
      const tailRaw = pat.slice(starStarIdx + 4);
      const root = join(cwd, prefixRaw);
      if (!existsSync(root)) continue;

      if (tailRaw.includes("*")) {
        continue;
      }

      walkFiles(root, (abs) => {
        const rel = relative(root, abs).replace(/\\/g, "/");
        if (tailRaw === "schema.ts") {
          if (basename(abs) === "schema.ts") out.add(abs);
          return;
        }
        if (rel === tailRaw || rel.endsWith(`/${tailRaw}`) || abs.endsWith(`/${tailRaw}`)) {
          out.add(abs);
        }
      });
      continue;
    }

    if (pat.includes("*")) {
      continue;
    }
  }

  return out;
}

function formatPgEndpoint(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    const host = u.hostname || "localhost";
    const port = u.port || "5432";
    return `${host}:${port}`;
  } catch {
    return "database host";
  }
}

function semverMajor(version: string): number | null {
  const v = version.trim().replace(/^v/i, "");
  const major = Number.parseInt(v.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

function symbolFor(status: Status): string {
  switch (status) {
    case "ok":
      return "✓";
    case "warn":
      return "⚠";
    case "fail":
      return "✗";
    case "info":
      return "ℹ";
  }
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Validate project setup (database, Drizzle schema, auth, env, adapters)",
  },
  args: {
    cwd: {
      type: "string",
      description: "Project root (default: current working directory)",
      default: ".",
    },
  },
  async run({ args }) {
    const cwd = resolve(process.cwd(), String(args.cwd ?? "."));
    const lines: Line[] = [];
    let redCount = 0;

    const push = (status: Status, text: string) => {
      lines.push({ status, text });
      if (status === "fail") redCount++;
    };

    const commercePath = join(cwd, "commerce.config.ts");
    const drizzlePath = join(cwd, "drizzle.config.ts");

    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      push("ok", "DATABASE_URL set");
    } else {
      push("fail", 'DATABASE_URL not set — add it to `.env` or your shell (e.g. `postgres://localhost:5432/mydb`).');
    }

    let pgReachable = false;
    if (databaseUrl) {
      const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
      try {
        await sql`SELECT 1`;
        pgReachable = true;
        push("ok", `Postgres reachable at ${formatPgEndpoint(databaseUrl)}`);
      } catch {
        push(
          "fail",
          "Cannot connect to Postgres — start your database or fix DATABASE_URL (check host, port, credentials).",
        );
      } finally {
        await sql.end({ timeout: 2 }).catch(() => undefined);
      }
    } else {
      push("warn", "Postgres connectivity not checked — DATABASE_URL is missing.");
    }

    let drizzleLoaded = false;
    let expandedSchemaFiles = new Set<string>();
    try {
      const drizzleMod = await import(pathToFileURL(drizzlePath).href);
      const cfg = drizzleMod.default as { schema?: unknown };
      const drizzlePatterns = Array.isArray(cfg.schema)
        ? cfg.schema.filter((x): x is string => typeof x === "string")
        : [];
      expandedSchemaFiles = expandDrizzlePatterns(drizzlePatterns, cwd);
      drizzleLoaded = true;
    } catch {
      push(
        "fail",
        "Could not load drizzle.config.ts — add one at the project root (see store-example).",
      );
    }

    if (!existsSync(commercePath)) {
      push(
        "fail",
        "commerce.config.ts not found — run `unifiedcommerce init` or add a config at the project root.",
      );
    } else if (drizzleLoaded) {
      const src = readFileSync(commercePath, "utf8");
      const bindings = parseImportBindings(src);

      const schemaBody = extractBracketArrayBody(src, "schema");
      const schemaIds = schemaBody ? extractSchemaIdentifiers(schemaBody) : [];
      const commerceDir = dirname(commercePath);

      const pluginsBody = extractBracketArrayBody(src, "plugins");
      const pluginIds = pluginsBody ? extractPluginCallerIds(pluginsBody) : [];

      const paths = new Set<string>();

      for (const pid of pluginIds) {
        const mod = bindings.get(pid);
        if (!mod || !mod.startsWith("@porulle/plugin-")) continue;
        const pkgRel = mod.replace(/^@porulle\//, "");
        paths.add(join(cwd, "node_modules/@porulle", pkgRel, "src/schema.ts"));
      }

      for (const sid of schemaIds) {
        const mod = bindings.get(sid);
        if (!mod || !(mod.startsWith("./") || mod.startsWith("../"))) continue;
        paths.add(resolveLocalModulePath(commerceDir, mod));
      }

      const requiredPaths = [...paths];

      const missingOnDisk = requiredPaths.filter((p) => !existsSync(p));
      if (missingOnDisk.length > 0) {
        push(
          "fail",
          `Schema file missing — run \`bun install\` so plugins exist (${missingOnDisk.length} path(s) not found under node_modules or src).`,
        );
      } else if (requiredPaths.length === 0) {
        push("ok", "No extra plugin/app schema paths detected in commerce.config.ts (core-only)");
      } else {
        const uncovered = requiredPaths.filter((p) => !expandedSchemaFiles.has(p));
        if (uncovered.length === 0) {
          push(
            "ok",
            `drizzle.config.ts covers all ${requiredPaths.length} required schema path(s)`,
          );
        } else {
          push(
            "fail",
            `drizzle.config.ts does not cover ${uncovered.length} schema path(s) — extend the \`schema\` array in drizzle.config.ts so Drizzle sees every plugin and local schema file (then run \`bun run db:push\`).`,
          );
        }
      }
    }

    if (pgReachable && databaseUrl) {
      const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
      try {
        await sql`SELECT 1 FROM "user" LIMIT 1`;
        push("ok", 'Auth tables present — "user" table is readable');
      } catch {
        push(
          "fail",
          "Auth tables not pushed — run `bun run db:push` (or your package's Drizzle push script).",
        );
      } finally {
        await sql.end({ timeout: 2 }).catch(() => undefined);
      }
    } else {
      push(
        "warn",
        'Skipped auth table check — Postgres not reachable (needs `"user"` table from Better Auth).',
      );
    }

    if (process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_SECRET.length > 0) {
      push("ok", "BETTER_AUTH_SECRET set");
    } else {
      push(
        "fail",
        "BETTER_AUTH_SECRET not set — generate one with `openssl rand -hex 32` and add it to `.env`.",
      );
    }

    if (process.env.BETTER_AUTH_URL && process.env.BETTER_AUTH_URL.length > 0) {
      push("ok", "BETTER_AUTH_URL set");
    } else {
      push(
        "fail",
        "BETTER_AUTH_URL not set — set it to your app's public base URL (e.g. `http://localhost:4000`).",
      );
    }

    push("info", "BETTER_AUTH_URL defaults to http://localhost:4000");

    if (!process.env.PORT) {
      push("info", "PORT is unset (optional)");
    }

    let configLoaded = false;
    try {
      if (existsSync(commercePath)) {
        const mod = await import(pathToFileURL(commercePath).href);
        let cfg = mod.default as unknown;
        cfg = await Promise.resolve(cfg as Promise<unknown> | unknown);
        if (cfg && typeof cfg === "object") {
          const o = cfg as Record<string, unknown>;
          const storage = o.storage;
          const databaseAdapter = o.databaseAdapter;

          if (storage && typeof storage === "object") {
            const providerId = (storage as { providerId?: string }).providerId;
            const label =
              typeof providerId === "string" && providerId.length > 0
                ? providerId
                : "storage adapter";
            push("ok", `Storage adapter configured (${label})`);
          } else {
            push(
              "fail",
              "Storage adapter missing — set `storage` in commerce.config.ts (e.g. localStorageAdapter or s3StorageAdapter).",
            );
          }

          if (databaseAdapter && typeof databaseAdapter === "object") {
            const provider = (databaseAdapter as { provider?: string }).provider;
            const label =
              typeof provider === "string" && provider.length > 0
                ? provider
                : "database adapter";
            push("ok", `Database adapter configured (${label})`);
          } else {
            push(
              "fail",
              "Database adapter missing — set `databaseAdapter` in commerce.config.ts (e.g. postgresAdapter).",
            );
          }

          configLoaded = true;
        }
      }
    } catch {
      push(
        "fail",
        "Could not load commerce.config.ts — fix syntax/runtime errors; doctor needs the resolved config.",
      );
    }

    let cliVersion = "";
    try {
      const cliPkg = await readJson<{ version?: string }>(
        join(CLI_ROOT, "../../package.json"),
      );
      cliVersion = cliPkg.version ?? "";
    } catch {
      cliVersion = "";
    }

    let coreVersion = "";
    try {
      const req = createRequire(join(cwd, "package.json"));
      const corePkgPath = req.resolve("@porulle/core/package.json");
      const corePkg = await readJson<{ version?: string }>(corePkgPath);
      coreVersion = corePkg.version ?? "";
    } catch {
      coreVersion = "";
    }

    if (!cliVersion || !coreVersion) {
      push("warn", "Could not compare CLI vs @porulle/core versions (package missing or not installed).");
    } else {
      const cliM = semverMajor(cliVersion);
      const coreM = semverMajor(coreVersion);
      if (cliM !== null && coreM !== null && cliM !== coreM) {
        push(
          "warn",
          `CLI ${cliVersion} major (${cliM}) differs from @porulle/core ${coreVersion} major (${coreM}) — align versions to avoid subtle breakage.`,
        );
      } else {
        push("ok", `CLI ${cliVersion} matches core ${coreVersion}`);
      }
    }

    console.log("");
    console.log("unicore doctor");
    console.log("");
    for (const { status, text } of lines) {
      console.log(`${symbolFor(status)} ${text}`);
    }

    const problems = redCount;
    console.log("");
    console.log(
      problems === 0
        ? "Result: no problems found."
        : problems === 1
          ? "Result: 1 problem found."
          : `Result: ${problems} problems found.`,
    );

    process.exit(problems > 0 ? 1 : 0);
  },
});
