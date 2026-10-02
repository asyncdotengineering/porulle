import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, "..");
const distIndex = join(cliRoot, "dist/index.js");

describe("CLI --version", () => {
  it("prints the version from package.json", async () => {
    const pkg = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8")) as {
      version: string;
    };

    const output = execSync(`"${process.execPath}" "${distIndex}" --version`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        USER: process.env.USER,
      },
    }).trim();

    expect(output).toBe(pkg.version);
  });
});
