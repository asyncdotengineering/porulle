import { spawn } from "node:child_process";
import { defineCommand } from "citty";

export const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Apply Drizzle migrations",
  },
  async run() {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const proc = spawn(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["drizzle-kit", "migrate"],
        { stdio: "inherit" },
      );
      proc.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`drizzle-kit migrate failed with code ${code}`));
      });
      proc.on("error", rejectPromise);
    });
  },
});
