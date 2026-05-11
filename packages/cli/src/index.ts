#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { generateMigrationCommand } from "./commands/generate-migration.js";
import { migrateCommand } from "./commands/migrate.js";
import { deployCommand } from "./commands/deploy.js";
import { importCommand } from "./commands/import.js";
import { apiKeyCommand } from "./commands/api-key.js";
import { doctorCommand } from "./commands/doctor.js";

const main = defineCommand({
  meta: {
    name: "@porulle/cli",
    version: "0.2.5",
    description: "UnifiedCommerce Engine CLI",
  },
  subCommands: {
    init: initCommand,
    dev: devCommand,
    migrate: migrateCommand,
    deploy: deployCommand,
    import: importCommand,
    "api-key": apiKeyCommand,
    doctor: doctorCommand,
    generate: defineCommand({
      subCommands: {
        migration: generateMigrationCommand,
      },
    }),
  },
});

await runMain(main);
