# Agentic Commerce Origin

Porulle commerce authority for the Kuralle
[Agentic Commerce Assistant](https://github.com/kuralle/kuralle-agents/tree/main/apps/examples/agentic-commerce-assistant).
It owns current catalog records, prices, inventory, carts, orders, checkout, and
Stripe payment state. Search and conversation concerns remain in Samesake and
Kuralle.

## Run with local PostgreSQL

Create the shared database and enable pgvector:

```bash
createdb kuralle_agentic_commerce
psql kuralle_agentic_commerce -c 'CREATE EXTENSION IF NOT EXISTS vector'
```

Configure the origin:

```bash
cd apps/agentic-commerce-origin
cp .env.example .env
```

Set `STRIPE_SECRET_KEY` to a Stripe test-mode secret. If you want to exercise
verified webhooks locally, run:

```bash
stripe listen --forward-to localhost:4000/api/payments/webhook
```

Copy the printed endpoint signing secret into `STRIPE_WEBHOOK_SECRET`, then
initialize and start the origin:

```bash
bun run db:push
bun run seed
bun run start
```

The seed command prints JSON containing `storefrontKey`. Store that value as
`PORULLE_STOREFRONT_KEY` in the Kuralle application. It grants only catalog,
cart, checkout, and order permissions from the `agent_storefront` scope.

## Use the agent catalog projection

The origin exposes two authenticated routes for the shopping agent:

```text
GET /agent/catalog/export
GET /agent/catalog/:productId
```

Send the scoped storefront key as a bearer token. The export route projects
active Porulle products into Samesake documents; the item route returns current
price and inventory for deterministic cart revalidation.

```bash
curl http://localhost:4000/agent/catalog/export \
  --header "Authorization: Bearer $PORULLE_STOREFRONT_KEY"
```

Checkout uses Porulle's standard authenticated cart and checkout APIs. The
Kuralle client supplies a stable idempotency key and a Stripe PaymentMethod
token; it never sends raw payment-card data.

## Deploy on Cloudflare with Neon

Apply the schema and seed against a Neon database or branch before deployment.
Put its Hyperdrive ID in `wrangler.jsonc`, then upload Stripe secrets and deploy:

```bash
bunx wrangler secret put STRIPE_SECRET_KEY
bunx wrangler secret put STRIPE_WEBHOOK_SECRET
bun run worker:deploy
```

Register this Stripe test-mode webhook URL after deployment:

```text
https://your-origin.example/api/payments/webhook
```

Porulle verifies `stripe-signature` with Stripe's Worker-compatible asynchronous
verifier. It claims each event and confirms the order identified by PaymentIntent
metadata in one database transaction; a failed status change rolls the claim back
so Stripe can retry, while duplicate deliveries remain no-ops. Keep the webhook
secret server-side and rotate it independently of the Stripe API secret.

## Verify before deployment

```bash
bun run check-types
bun run test
bun run worker:check
```

Use Stripe test keys and test PaymentMethods while validating the example. Real
customer applications must create PaymentMethods outside the model, configure a
verified webhook endpoint, and treat Porulle—not an agent response—as the order
and payment authority.
