import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import consola from "consola";
import { downloadTemplate } from "giget";
import { copyDir, readJson, writeJson } from "../utils.js";

const currentDir = fileURLToPath(new URL(".", import.meta.url));

interface PackageJsonShape {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

// Scaffolded projects must pin @porulle/* to the version of the CLI that
// created them: the packages are a fixed-version group, so the running CLI's
// own version is the correct, coherent target. A literal range baked into the
// template would go stale on every release.
export function pinPorulleDependencies(
  pkg: PackageJsonShape,
  version: string,
): void {
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    const record = deps as Record<string, string>;
    for (const name of Object.keys(record)) {
      if (name.startsWith("@porulle/")) {
        record[name] = `^${version}`;
      }
    }
  }
}

async function readCliVersion(): Promise<string | undefined> {
  const pkg = await readJson<PackageJsonShape>(
    resolve(currentDir, "../../package.json"),
  );
  return pkg.version;
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold a UnifiedCommerce project",
  },
  args: {
    projectName: {
      type: "positional",
      description: "Project directory name",
      required: true,
    },
    template: {
      type: "string",
      default: "starter",
    },
  },
  async run({ args }) {
    const projectName = String(args.projectName);
    const destination = resolve(process.cwd(), projectName);

    if (existsSync(destination)) {
      throw new Error(`Directory ${destination} already exists.`);
    }

    const localTemplatePath = resolve(currentDir, "../../templates", String(args.template));

    if (existsSync(localTemplatePath)) {
      await copyDir(localTemplatePath, destination);
    } else {
      await downloadTemplate(`gh:unifiedcommerce/templates/${String(args.template)}`, {
        dir: destination,
      });
    }

    const packageJsonPath = join(destination, "package.json");
    if (existsSync(packageJsonPath)) {
      const pkg = await readJson<PackageJsonShape>(packageJsonPath);
      pkg.name = projectName;
      const cliVersion = await readCliVersion();
      if (cliVersion) {
        pinPorulleDependencies(pkg, cliVersion);
      }
      await writeJson(packageJsonPath, pkg);
    }

    consola.success(`Project created at ${destination}`);
    consola.info(`Next steps:`);
    consola.info(`  cd ${projectName}`);
    consola.info(`  bun install`);
    consola.info(`  bun run dev`);
  },
});
