---
title: Introduction
description: What Porulle is, what it provides, and who it is for.
---

Porulle is a TypeScript-first headless commerce framework. You install it into a TypeScript project the way you install Payload, Inngest, or Temporal — as a library, not a hosted service. It gives you a complete commerce backend wired together through a single `defineConfig`, exposed as a hardened REST API, and extensible through a typed plugin system.

The Tamil root *porul* (பொருள் — *thing / substance / merchandise / meaning*) is embedded in the name.

## What it provides

**Kernel:** catalog, cart, checkout, orders, inventory, pricing, promotions, fulfillment, customers, search, tax, shipping — all coordinated through a single service layer. No orphaned services, no duplicated business logic across routes.

**Adapter pattern:** swap PostgreSQL variants, payment processors (Stripe and others), file storage (local, S3, R2), search engines (Meilisearch, built-in PostgreSQL full-text), tax providers (TaxJar, manual), and email (Resend, SES) behind clean interfaces. The kernel never imports a vendor SDK directly.

**Plugin system:** plugins are config transforms — plain functions that receive `CommerceConfig` and return a modified `CommerceConfig`. They contribute schema tables, hook handlers, REST routes, and analytics models without forking core. First-party plugins: marketplace, loyalty, reviews, gift cards, POS, appointments, and more.

**Hook pipeline:** intercept any operation (catalog create, cart update, checkout, order status change) with typed before/after handlers. Before hooks run inside the database transaction; after hooks run outside it. The checkout pipeline uses a compensation chain so external side-effects (payment capture, inventory decrement, email) can be safely reversed on failure.

**Multi-tenancy:** every row carries `organizationId`. A single-store deployment uses `org_default` silently. A multi-store SaaS configures `storeResolver` to map requests to org IDs. The data isolation test suite (`packages/core/test/multi-org-isolation.test.ts`) verifies cross-org access fails for every operation.

**Security posture:** five-round adversarial audit before extraction. SSRF guards, CSRF, body limits, per-IP and per-account rate limits, `__Secure-` cookies, CSP hook, magic-byte MIME validation, timing-safe webhook verification. Every mutation lands in the audit log.

**OpenAPI:** `GET /api/doc` emits a JSON spec, `GET /api/reference` serves the interactive Scalar explorer. Both include plugin routes automatically.

## Who it is for

**Application developers** building storefronts, admin dashboards, POS systems, or marketplaces who want a commerce backend they own and can read.

**Platform engineers** who need a commerce kernel they can extend with project-specific plugins without forking the engine.

**AI engineers** wrapping the REST API in an agent layer. Porulle is REST-only by design; MCP/UCP/ACP shims live above it.

## What it is not

Porulle is not a hosted service, not a SaaS, and not a no-code platform. You run PostgreSQL. You deploy the server. You write plugins in TypeScript.

It is also not batteries-for-all-use-cases included by default. A tea shop doesn't need the marketplace plugin. A marketplace doesn't need kitchen display tickets. Start with `@porulle/core` and add plugins as your use case demands them.

## Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript 5.9, Bun 1.3, Node ≥18 |
| HTTP | Hono (runtime-agnostic: Bun, Node, Cloudflare Workers) |
| Database | PostgreSQL 15+ via Drizzle ORM |
| Auth | Better Auth with organization plugin |
| ORM | Drizzle (schema-as-code, SQL-like query builder) |
| Testing | Vitest + PGlite (real PostgreSQL, in-process) |

## Adopter contracts

Three documents codify the rules for extending Porulle. Read them before writing a plugin or payment adapter.

- [Plugin Contract](/extending/plugin-contract/) — actor resolution, org scoping, Result contract
- [Payment Adapter Contract](/extending/payment-adapter-contract/) — capture accuracy, webhook verification, idempotency
- [Security Model](/production/security-model/) — threat model, rate limits, cookie hygiene, Phase 2 gaps

## Status

v0.1.0 alpha. Stable surface: REST API, multi-tenant kernel, plugin contract, adapter contracts, security model. Unstable / Phase 2: agent-native principal model, multi-protocol gateway (MCP, UCP, ACP), conversation layer, per-region data residency.

This framework was extracted from a production commerce engine after a five-round adversarial security review. Every cross-tenant leak, race condition, IDOR, and information-disclosure surface caught was fixed and pinned with a regression test before this release.

## Next steps

- [Install](/get-started/install/) — set up the packages and database
- [Quickstart](/get-started/quickstart/) — a working API in five minutes
- [Your First Store tutorial](/tutorials/first-store/) — a complete walkthrough with products, inventory, and checkout
