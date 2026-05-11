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
  [key: string]: unknown;
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
      await writeJson(packageJsonPath, pkg);
    }

    consola.success(`Project created at ${destination}`);
    consola.info(`Next steps:`);
    consola.info(`  cd ${projectName}`);
    consola.info(`  bun install`);
    consola.info(`  bun run dev`);
  },
});
