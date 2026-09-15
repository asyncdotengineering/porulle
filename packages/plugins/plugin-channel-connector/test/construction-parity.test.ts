/**
 * The suites must build `ChannelConnectorService` the way the deployed import builds it.
 *
 * Production builds it two ways. Eight task handlers in `src/index.ts` and the hook in
 * `src/hooks.ts` pass three arguments, the first being the plugin db HANDLE (`ctx.db`), because a
 * `TaskContext` carries no adapter. `routes:` passes a fourth, `ctx.database.transaction`, because
 * a route context does. Both are real; the fourth argument is not a test seam.
 *
 * What was wrong is which one the suites used. Twenty-two of twenty-four hand-constructions passed
 * the REST shape while asserting on the import, so they ran a transaction path the job never takes.
 * Measured on 2026-09-15 by removing the after-commit wrap from `normalizeExecuteShape` in the
 * built core: the two suites built the task way went from 27 s to 467 s and 576 s, and the two
 * built the REST way did not move (13 s, 25 s) — they were never on that path to begin with.
 *
 * This test derives the required shape from `src/` rather than naming a number, so it keeps holding
 * when production's shape changes. A suite that genuinely needs to observe a transaction wraps the
 * db handle, which is an argument production also supplies — see `entity-map-atomicity.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const self = new URL(import.meta.url).pathname;
const pkg = join(self, "..", "..");

type Site = { file: string; line: number; args: string[] };

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : tsFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Split the top-level arguments of the call whose `(` is at `open`, tracking bracket depth and
 * string, template and comment state so nested calls, object literals and commas inside strings are
 * not miscounted. A trailing comma before `)` closes no argument — counting it as one is what made
 * the first draft of this test read the four-argument `routes:` construction as five, and report a
 * production shape that does not exist.
 */
function splitArgs(source: string, open: number): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = i;
      i += 1;
      for (; i < source.length; i += 1) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === quote) break;
      }
      current += source.slice(start, i + 1);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      if (depth > 1) current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === "," && depth === 1) {
      if (current.trim()) args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  throw new Error(`Unterminated call at offset ${open}`);
}

function sites(dir: string): Site[] {
  const found: Site[] = [];
  const needle = `new ${"ChannelConnectorService"}(`;
  for (const file of tsFiles(join(pkg, dir))) {
    if (file === self) continue;
    const source = readFileSync(file, "utf8");
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
      found.push({
        file: file.slice(pkg.length + 1),
        line: source.slice(0, at).split("\n").length,
        args: splitArgs(source, at + needle.length - 1),
      });
    }
  }
  return found;
}

/** A plugin db handle argument: `ctx.db`, `context.db` — what a TaskContext hands a task handler. */
const isPluginDbHandle = (arg: string) => /^[A-Za-z_$][\w$]*\.db$/.test(arg);

describe("ChannelConnectorService construction parity", () => {
  const production = sites("src");
  const suites = sites("test");
  const jobPath = production.filter((site) => isPluginDbHandle(site.args[0] ?? ""));

  it("finds the production job-path construction to derive the shape from", () => {
    expect(
      production.length,
      "no production construction sites in src/ — this test can derive nothing and is asserting nothing",
    ).toBeGreaterThan(0);
    expect(
      jobPath.map((site) => `${site.file}:${site.line}`),
      "no production site takes a plugin db handle (`ctx.db`) as its first argument. Either the job " +
        "path is gone or it was renamed; either way the shape below is no longer derived from anything.",
    ).not.toEqual([]);
  });

  it("hand-builds the service in every suite the way the deployed job builds it", () => {
    const shapes = [...new Set(jobPath.map((site) => site.args.length))];
    expect(shapes, `production's job path is not self-consistent: ${JSON.stringify(jobPath)}`).toHaveLength(1);
    const required = shapes[0]!;

    const divergent = suites
      .filter((site) => site.args.length !== required)
      .map((site) => `${site.file}:${site.line} passes ${site.args.length}: (${site.args.join(", ")})`);

    expect(
      divergent,
      `the deployed job builds this service with ${required} argument(s) — ${jobPath.length} call ` +
        `sites in src/, each taking a plugin db handle first. A suite that hand-builds it another ` +
        `way runs a transaction path the job never takes, which is how the connector suites stayed ` +
        `green over an after-commit fix that was inert on the deployed import. To observe a ` +
        `transaction, wrap the db handle instead — production supplies that argument too.`,
    ).toEqual([]);
  });
});
