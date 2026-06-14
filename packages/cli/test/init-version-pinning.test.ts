import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pinPorulleDependencies } from "../src/commands/init.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPackageJson = join(__dirname, "../package.json");

describe("pinPorulleDependencies", () => {
  it("rewrites every @porulle/* dependency to ^version across all sections", () => {
    const pkg = {
      dependencies: {
        "@porulle/core": "workspace:*",
        "@porulle/adapter-postgres": "^0.5.0",
        hono: "^4.0.0",
      },
      devDependencies: {
        "@porulle/cli": "*",
        "drizzle-kit": "^0.31.9",
      } as Record<string, string>,
    };

    pinPorulleDependencies(pkg, "0.6.0");

    expect(pkg.dependencies["@porulle/core"]).toBe("^0.6.0");
    expect(pkg.dependencies["@porulle/adapter-postgres"]).toBe("^0.6.0");
    expect(pkg.devDependencies["@porulle/cli"]).toBe("^0.6.0");
  });

  it("leaves non-@porulle dependencies untouched", () => {
    const pkg = {
      dependencies: { "@porulle/core": "workspace:*", hono: "^4.0.0" },
    };

    pinPorulleDependencies(pkg, "0.6.0");

    expect(pkg.dependencies.hono).toBe("^4.0.0");
  });

  it("is a no-op when a section is absent", () => {
    const pkg = { name: "x" };
    expect(() => pinPorulleDependencies(pkg, "0.6.0")).not.toThrow();
  });

  it("the CLI's own package.json exposes a concrete version to pin against", async () => {
    const pkg = JSON.parse(await readFile(cliPackageJson, "utf8")) as {
      version?: string;
    };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
