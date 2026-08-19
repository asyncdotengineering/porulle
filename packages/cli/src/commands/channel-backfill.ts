import { defineCommand } from "citty";
import consola from "consola";

type BackfillReport = Record<string, unknown>;

function baseUrl(raw: string | undefined): string {
  return (raw ?? "http://localhost:3000").replace(/\/$/, "");
}

async function requestBackfill(
  url: string,
  storeId: string,
  dryRun: boolean,
  restart: boolean,
  token?: string,
): Promise<BackfillReport> {
  const response = await fetch(`${url}/api/channels/stores/${encodeURIComponent(storeId)}/backfill`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ dryRun, ...(restart ? { restart: true } : {}) }),
  });
  const payload = (await response.json().catch(() => ({}))) as { data?: BackfillReport; error?: { message?: string } };
  if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? `Backfill request failed (${response.status}).`);
  return payload.data;
}

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
    const report = await requestBackfill(
      baseUrl(args.targetUrl ? String(args.targetUrl) : undefined),
      String(args.store),
      dryRun,
      args.restart === true,
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
