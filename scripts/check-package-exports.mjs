#!/usr/bin/env node
/**
 * Proves every publishable @porulle package can be loaded the way consumers load it.
 *
 * 0.65.0 shipped plugins whose root export had only an `import` condition: `require()` — which is
 * how drizzle-kit loads a schema file that imports a plugin — threw ERR_PACKAGE_PATH_NOT_EXPORTED,
 * and drizzle-kit still exited 0. publint --strict and attw both passed those packages (attw
 * resolves TYPES through the `types` condition), so this script checks the behaviour itself:
 *
 *   1. contract   every export entry is { "@porulle/source"?, "types": dist .d.ts, "default": dist .js }
 *                 and both targets exist; "./package.json" is exported;
 *   2. runtime    each entry resolves AND loads by package name through require() and import(), run in a
 *                 child process inside the package (self-reference uses the same exports resolution a
 *                 consumer gets). A package whose code imports a Workers-only module (`cloudflare:*`)
 *                 cannot load under Node; it is resolution-checked only, and reported as such;
 *   3. publint    --strict;
 *   4. attw       node16 profile; a CJS caller reaching an ESM file is accepted (Node ≥ 20.19 loads it).
 *
 * Run after `turbo run build`. Exits 1 on any failure, and on checking zero packages.
 *   node scripts/check-package-exports.mjs [--skip-attw] [--only <name>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const skipAttw = args.includes("--skip-attw");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

function publishablePackages() {
  const dirs = [];
  for (const group of ["packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, group, entry.name);
      if (existsSync(join(dir, "package.json"))) dirs.push(dir);
      for (const nested of readdirSync(dir, { withFileTypes: true })) {
        if (nested.isDirectory() && existsSync(join(dir, nested.name, "package.json"))) dirs.push(join(dir, nested.name));
      }
    }
  }
  return dirs
    .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
    .filter(({ pkg }) => !pkg.private && pkg.name?.startsWith("@porulle/") && pkg.exports)
    .filter(({ pkg }) => !only || pkg.name === only);
}

function contractProblems({ dir, pkg }) {
  const problems = [];
  if (pkg.exports["./package.json"] !== "./package.json") problems.push(`missing "./package.json": "./package.json" export`);
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (subpath === "./package.json") continue;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${subpath}: expected a conditions object`);
      continue;
    }
    const keys = Object.keys(entry);
    const allowed = ["@porulle/source", "types", "default"];
    const extra = keys.filter((k) => !allowed.includes(k));
    if (extra.length) problems.push(`${subpath}: unexpected conditions ${extra.join(", ")}`);
    const order = keys.filter((k) => allowed.includes(k));
    const expected = allowed.filter((k) => keys.includes(k));
    if (order.join() !== expected.join()) problems.push(`${subpath}: conditions out of order (${order.join(", ")})`);
    if (typeof entry.types !== "string" || !entry.types.startsWith("./dist/") || !entry.types.endsWith(".d.ts")) {
      problems.push(`${subpath}: "types" must point at a .d.ts in dist (got ${entry.types})`);
    } else if (!existsSync(join(dir, entry.types))) problems.push(`${subpath}: ${entry.types} does not exist (built?)`);
    if (typeof entry.default !== "string" || !entry.default.startsWith("./dist/") || !entry.default.endsWith(".js")) {
      problems.push(`${subpath}: "default" must point at a .js in dist (got ${entry.default})`);
    } else if (!existsSync(join(dir, entry.default))) problems.push(`${subpath}: ${entry.default} does not exist (built?)`);
  }
  return problems;
}

const runtimeProbe = `
const { createRequire } = await import("node:module");
const [name, subpaths] = [process.argv[1], JSON.parse(process.argv[2])];
const require = createRequire(process.cwd() + "/package.json");
const out = [];
for (const sub of subpaths) {
  const spec = sub === "." ? name : name + sub.slice(1);
  const row = { sub };
  try { require.resolve(spec); row.requireResolve = "ok"; } catch (e) { row.requireResolve = e.code ?? e.message; }
  try { import.meta.resolve(spec); row.importResolve = "ok"; } catch (e) { row.importResolve = e.code ?? e.message; }
  try { require(spec); row.requireLoad = "ok"; } catch (e) { row.requireLoad = String(e.message).includes("cloudflare:") ? "workers-only" : (e.code ?? e.message); }
  try { await import(spec); row.importLoad = "ok"; } catch (e) { row.importLoad = String(e.message).includes("cloudflare:") ? "workers-only" : (e.code ?? e.message); }
  out.push(row);
}
console.log(JSON.stringify(out));
`;

function runtimeProblems({ dir, pkg }) {
  const subpaths = Object.keys(pkg.exports).filter((s) => s !== "./package.json");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", runtimeProbe, pkg.name, JSON.stringify(subpaths)], {
    cwd: dir,
    encoding: "utf8",
  });
  const line = result.stdout.trim().split("\n").at(-1);
  let rows;
  try {
    rows = JSON.parse(line);
  } catch {
    return [`runtime probe did not report (exit ${result.status}): ${result.stderr.trim().split("\n").slice(-2).join(" ")}`];
  }
  const problems = [];
  for (const row of rows) {
    for (const key of ["requireResolve", "importResolve", "requireLoad", "importLoad"]) {
      if (row[key] !== "ok" && row[key] !== "workers-only") problems.push(`${row.sub}: ${key} → ${row[key]}`);
    }
  }
  return problems;
}

function toolProblems(label, command, commandArgs, cwd) {
  try {
    execFileSync(command, commandArgs, { cwd, encoding: "utf8", stdio: "pipe" });
    return [];
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n");
    return [`${label} failed: ${output.filter((l) => /error|warning|💀|❌|🐛|problem/i.test(l)).slice(0, 4).join(" | ") || output.slice(-3).join(" | ")}`];
  }
}

const packages = publishablePackages();
if (packages.length === 0) {
  console.error("check-package-exports: no packages checked — refusing to report success");
  process.exit(1);
}

const bin = (name) => join(root, "node_modules", ".bin", name);
let failed = 0;
for (const target of packages) {
  const problems = [
    ...contractProblems(target),
    ...runtimeProblems(target),
    ...toolProblems("publint --strict", bin("publint"), ["--strict"], target.dir),
    ...(skipAttw
      ? []
      : toolProblems("attw", bin("attw"), ["--pack", ".", "--profile", "node16", "--ignore-rules", "cjs-resolves-to-esm"], target.dir)),
  ];
  if (problems.length) {
    failed += 1;
    console.log(`✗ ${target.pkg.name}`);
    for (const problem of problems) console.log(`    ${problem}`);
  } else {
    console.log(`✓ ${target.pkg.name}`);
  }
}
console.log(`check-package-exports: ${packages.length} package(s) checked, ${failed} failed`);
process.exit(failed ? 1 : 0);
