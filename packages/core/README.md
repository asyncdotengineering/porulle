# @porulle/core

The kernel — services, adapters, hooks, state machines, auth, runtime. Everything else in the monorepo composes on top of it.

## What's inside

```
src/
├── runtime/          createServer, createKernel, logger, shutdown
├── kernel/           plugin manifest, hook registry, jobs, state machines, errors
├── modules/          catalog, cart, checkout, orders, inventory, payments,
│                     fulfillment, customers, pricing, promotions, search,
│                     tax, shipping, media, webhooks, audit, organization
├── interfaces/rest/  OpenAPI-documented HTTP routes (Hono + zod-openapi)
├── auth/             actor, permissions, ownership, org resolution, middleware
├── adapters/         adapter contracts (database, jobs)
├── config/           defineConfig, CommerceConfig types
├── hooks/            checkout pipeline, order emails
└── utils/            id, logger, agent-prompt
```

## Public exports

```ts
// Top-level
import { defineConfig, defineCommercePlugin, createServer, createKernel, router } from "@porulle/core";
import type { CommerceConfig, Actor, Kernel, HookContext } from "@porulle/core";

// Sub-paths
import { schema } from "@porulle/core/schema";
import * as authSchema from "@porulle/core/auth-schema";
import { createTestKernel } from "@porulle/core/testing";
import * as drizzle from "@porulle/core/drizzle";
```

The `./testing` sub-path is split out so test-only deps (drizzle-kit, tsx, esbuild) don't pollute production bundle graphs.

## How it fits

- Adopters write a single `commerce.config.ts` and call `createServer(config)` — done.
- Plugins (`defineCommercePlugin`) and adapters (`PaymentAdapter`, `StorageAdapter`, `SearchAdapter`, etc.) extend the kernel without touching its source.
- The kernel knows nothing about HTTP. The same kernel runs behind a Hono server, a CLI tool, a test harness, or any custom interface adopters layer on top.

## Conventions

- Services return `Result<T>` (`Ok(value)` / `Err(CommerceError)`). They never throw across module boundaries.
- Every tenant-scoped query includes `organizationId` in the WHERE — enforced by repository contracts and audit-traceable.
- Every mutation writes a row to `commerce_audit_log`.
- Drizzle is the ORM. Raw SQL is an escape hatch, used sparingly.

## See also

- [Plugin Contract](https://github.com/asyncdotengineering/porulle/blob/main/apps/docs/src/content/docs/extending/plugin-contract.mdx) — what plugin authors must follow
- [Payment Adapter Contract](https://github.com/asyncdotengineering/porulle/blob/main/apps/docs/src/content/docs/extending/payment-adapter-contract.mdx) — payment adapter rules
- [`SECURITY.md`](../../SECURITY.md) — threat model + posture
- [Root README](../../README.md) — the framework overview
