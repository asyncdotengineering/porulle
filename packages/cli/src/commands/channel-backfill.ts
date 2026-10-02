import { defineCommand } from "citty";
import consola from "consola";
import { apiBaseUrl, requestJson } from "../utils.js";

type BackfillReport = Record<string, unknown>;

export const channelBackfillCommand = defineCommand({
  meta: {
    name: "channel:backfill",
    description: "Backfill an already-imported channel catalog into the PIM.",
  },
  args: {
    store: {
      type: "string",
      required: true,
      description: "Connected store id",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Report changes without writing",
    },
    restart: {
      type: "boolean",
      default: false,
      description: "Discard the persisted backfill cursor and start over",
    },
    targetUrl: {
      type: "string",
      default: "http://localhost:3000",
      description: "UnifiedCommerce API base URL",
    },
    authToken: {
      type: "string",
      description: "Bearer token for the target API",
    },
  },
  async run({ args }) {
    const dryRun = args["dry-run"] === true;
    const url = apiBaseUrl(args.targetUrl ? String(args.targetUrl) : undefined);
    const report = await requestJson<BackfillReport>(
      url,
      `/api/channels/stores/${encodeURIComponent(String(args.store))}/backfill`,
      "POST",
      { dryRun, ...(args.restart === true ? { restart: true } : {}) },
      args.authToken ? String(args.authToken) : undefined,
    );
    if (dryRun) {
      consola.success(`Channel catalog backfill dry run for ${String(args.store)}.`);
    } else {
      consola.success(`Channel catalog backfill enqueued for ${String(args.store)} (runs as a durable job).`);
    }
    consola.info(JSON.stringify(report, null, 2));
  },
});
