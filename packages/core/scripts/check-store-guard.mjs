/**
 * No module-scope store in core: `\bstore\.` must not appear in `packages/core/src`.
 *
 * A Worker isolate is reused across requests and across tenants. Anything a module holds between
 * requests is shared by every request that isolate serves after it, so a module-scope store is how
 * one organization's data reaches another's response — and it fails silently, since a single-tenant
 * local run never shows it.
 *
 * **This is a ratchet that has finished, and its baseline is empty on purpose.**
 * It once allowed 247 occurrences across 20 files; on 2026-09-15 every one of those files measured
 * **0**, and four of the entries named files that no longer existed. An allow-list kept past the
 * point it allows anything real is 247 free future violations: `src/modules/catalog/service.ts` was
 * allowed 96 with 0 actual, so 96 could have been reintroduced without a word from this gate.
 *
 * **So the baseline stays `{}` and an entry is a decision a human makes, not something added to go
 * green.** That distinction is the whole reason this note exists: a worker closing a red gate added
 * `"src/kernel/hooks/deferred.ts": 2` during the 0.35.0 release, and the declared count matched the
 * actual count exactly — which is what an honest registration and an allowance look like from the
 * outside. Those two turned out to be `AsyncLocalStorage.getStore()`, a name collision rather than a
 * violation, and were resolved by renaming the binding rather than by allowing them.
 *
 * If you are here because this gate went red: the answer is almost always to remove the state, or
 * to rename a binding that merely collides with the word. Adding an entry needs a reviewer who
 * agrees the state is genuinely per-request.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const coreDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const srcDir = path.join(coreDir, "src");
const baselinePath = path.join(coreDir, "scripts", "store-write-baseline.json");

async function listTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...await listTsFiles(full));
      continue;
    }
    if (entry.isFile() && full.endsWith(".ts")) {
      output.push(full);
    }
  }
  return output;
}

function countStoreWrites(content) {
  const matches = content.match(/\bstore\./g);
  return matches ? matches.length : 0;
}

async function main() {
  const baselineRaw = await fs.readFile(baselinePath, "utf8");
  const baseline = JSON.parse(baselineRaw);

  const files = await listTsFiles(srcDir);
  const overages = [];

  for (const file of files) {
    const relative = path.relative(coreDir, file).replaceAll(path.sep, "/");
    const content = await fs.readFile(file, "utf8");
    const current = countStoreWrites(content);
    const allowed = baseline[relative] ?? 0;
    if (current > allowed) {
      overages.push({ file: relative, current, allowed });
    }
  }

  if (overages.length > 0) {
    console.error("Store guard failed. New store usage introduced:");
    for (const item of overages) {
      console.error(`- ${item.file}: ${item.current} > ${item.allowed}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
