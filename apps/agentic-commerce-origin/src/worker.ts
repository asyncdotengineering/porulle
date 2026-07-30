import { neonAdapter } from "@porulle/adapter-neon";
import { createServer } from "@porulle/core";
import { createOriginConfig } from "../commerce.config.js";

interface Env {
  DATABASE_URL: string;
  PUBLIC_URL: string;
  /** Legacy slot retained only for backwards-compatible secret rotation. */
  STRIPE_SECRET_KEY?: string;
  /** Rotation slot preferred over the legacy binding when present. */
  STRIPE_SECRET_KEY_CURRENT?: string;
  /** Fresh rotation candidate; promote by deploying before retiring CURRENT. */
  STRIPE_SECRET_KEY_NEXT?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  HYPERDRIVE?: Hyperdrive;
}

let cached: Promise<Awaited<ReturnType<typeof createServer>>> | undefined;

function stripeSecret(env: Env): string {
  const key =
    env.STRIPE_SECRET_KEY_CURRENT?.trim() ||
    env.STRIPE_SECRET_KEY_NEXT?.trim() ||
    env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("A Stripe secret-key binding is required");
  return key;
}

function server(env: Env) {
  cached ??= createOriginConfig({
    ...env,
    STRIPE_SECRET_KEY: stripeSecret(env),
  }, neonAdapter({
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
