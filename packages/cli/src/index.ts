#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { importCommand } from "./commands/import.js";
import { apiKeyCommand } from "./commands/api-key.js";
import { doctorCommand } from "./commands/doctor.js";
import { channelBackfillCommand } from "./commands/channel-backfill.js";
import { readCliVersion } from "./utils.js";

const cliVersion = await readCliVersion();

const main = defineCommand({
  meta: {
    name: "@porulle/cli",
    version: cliVersion ?? "0.0.0",
    description: "UnifiedCommerce Engine CLI",
  },
  subCommands: {
    init: initCommand,
    dev: devCommand,
    import: importCommand,
    "api-key": apiKeyCommand,
    doctor: doctorCommand,
    "channel:backfill": channelBackfillCommand,
  },
});

await runMain(main);
