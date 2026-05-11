import { spawn } from "node:child_process";
import { defineCommand } from "citty";

export const generateMigrationCommand = defineCommand({
  meta: {
    name: "generate migration",
    description: "Generate Drizzle migration",
  },
  async run() {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const proc = spawn(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["drizzle-kit", "generate"],
        { stdio: "inherit" },
      );
      proc.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`drizzle-kit generate failed with code ${code}`));
      });
      proc.on("error", rejectPromise);
    });
  },
});
