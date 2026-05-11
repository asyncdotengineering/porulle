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
