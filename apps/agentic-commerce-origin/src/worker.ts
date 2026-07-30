import { neonAdapter } from "@porulle/adapter-neon";
import { createServer } from "@porulle/core";
import { createOriginConfig } from "../commerce.config.js";

interface Env {
  DATABASE_URL: string;
  PUBLIC_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET?: string;
  HYPERDRIVE?: Hyperdrive;
}

let cached: Promise<Awaited<ReturnType<typeof createServer>>> | undefined;

function server(env: Env) {
  cached ??= createOriginConfig(env, neonAdapter({
    connectionString: env.DATABASE_URL,
    hyperdrive: env.HYPERDRIVE,
  })).then((config) => createServer(config));
  return cached;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await server(env)).app.fetch(request);
  },
} satisfies ExportedHandler<Env>;
