#!/usr/bin/env node

/**
 * SDK Codegen CLI — generates TypeScript types from your UC server's OpenAPI spec.
 *
 * Usage:
 *   bunx @porulle/sdk generate                          # from running server on :3000
 *   bunx @porulle/sdk generate --url http://localhost:4000/api/doc
 *   bunx @porulle/sdk generate --output src/types/api.ts
 *
 * This fetches /api/doc from your running server and runs openapi-typescript
 * to produce a paths type file. Commit the output alongside your code.
 */

import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0];

if (command !== "generate") {
  console.log(`
@porulle/sdk — Type Generation CLI

Usage:
  bunx @porulle/sdk generate [options]

Options:
  --url <url>       OpenAPI spec URL (default: http://localhost:3000/api/doc)
  --output <path>   Output file path (default: src/generated/api-types.ts)

Examples:
  bunx @porulle/sdk generate
  bunx @porulle/sdk generate --url http://localhost:4000/api/doc
  bunx @porulle/sdk generate --output src/types/commerce.ts
  `);
  process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 1);
}

const urlIdx = args.indexOf("--url");
const outputIdx = args.indexOf("--output");

const specUrl = urlIdx !== -1 && args[urlIdx + 1]
  ? args[urlIdx + 1]!
  : process.env.API_URL ?? "http://localhost:3000/api/doc";

const outputFile = outputIdx !== -1 && args[outputIdx + 1]
  ? args[outputIdx + 1]!
  : "src/generated/api-types.ts";

const outputDir = dirname(outputFile);
const tempSpec = join(outputDir, "_spec.json");

async function main() {
  console.log(`Fetching OpenAPI spec from ${specUrl}...`);

  let res: Response;
  try {
    res = await fetch(specUrl);
  } catch (err) {
    console.error(`\nCould not connect to ${specUrl}`);
    console.error("");
    console.error("Make sure your server is running:");
    console.error("  bun run dev");
    console.error("");
    console.error("Or specify a custom URL:");
    console.error("  bunx @porulle/sdk generate --url http://your-server/api/doc");
    process.exit(1);
    return; // unreachable, satisfies TS
  }

  if (!res.ok) {
    console.error(`Server returned ${res.status} ${res.statusText}`);
    console.error("Make sure the OpenAPI spec is enabled (GET /api/doc should return JSON).");
    process.exit(1);
  }

  const spec = await res.json() as { paths?: Record<string, unknown> };
  const pathCount = Object.keys(spec.paths ?? {}).length;

  if (pathCount === 0) {
    console.error("OpenAPI spec has 0 paths. Is the server configured correctly?");
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(tempSpec, JSON.stringify(spec, null, 2));
  console.log(`Spec extracted: ${pathCount} paths`);

  console.log(`Generating types → ${outputFile}`);
  try {
    execSync(`npx openapi-typescript ${tempSpec} -o ${outputFile}`, {
      stdio: "inherit",
    });
  } catch {
    console.error("openapi-typescript failed. Is it installed?");
    console.error("  bun add -d openapi-typescript");
    process.exit(1);
  }

  try { unlinkSync(tempSpec); } catch {}

  console.log(`\nDone — ${pathCount} paths typed in ${outputFile}`);
  console.log("Commit this file alongside your route changes.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
