import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import consola from "consola";

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    description: "Deploy UnifiedCommerce app to a target environment.",
  },
  args: {
    target: {
      type: "string",
      required: true,
      description: "Deployment target. Supported: vercel",
    },
    prod: {
      type: "boolean",
      default: false,
      description: "Deploy production build",
    },
  },
  async run({ args }) {
    const target = String(args.target).toLowerCase();

    if (target !== "vercel") {
      throw new Error(`Unsupported deploy target: ${target}. Currently supported: vercel.`);
    }

    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const deployArgs = ["vercel", "deploy"];
    if (args.prod) deployArgs.push("--prod");

    consola.info(`Running deploy for target=${target} (${deployArgs.join(" ")})`);

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const proc = spawn(command, deployArgs, {
        stdio: "inherit",
        shell: false,
      });

      proc.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`Deploy command failed with code ${code}`));
      });

      proc.on("error", rejectPromise);
    });
  },
});
