# What UnifiedCommerce Engine Can Learn from EmDash

> Research synthesis from EmDash CMS (Cloudflare) — comparing patterns, identifying gaps, and prioritizing steals.

---

## 1. Capability-Based Plugin Security (HIGH PRIORITY)

### What EmDash Does
EmDash plugins declare **capabilities** upfront in their manifest (`read:content`, `write:media`, `email:send`, `network:fetch`). The runtime enforces these at two levels:

1. **Hook-level requirements** — `content:beforeSave` requires `write:content`. A plugin without it can't register.
2. **Context binding** — `ctx.email` is only present if the plugin declared `email:send`. No `ctx.http` unless `network:fetch` was declared.
3. **Network host restriction** — `allowedHosts: ["api.stripe.com"]` limits outbound fetch to specific domains. Wildcards supported.
4. **SSRF protection** on all network calls, even unrestricted ones.

Plugins run in **sandboxed Worker isolates** (Cloudflare Dynamic Workers). Fresh bridge per request. CPU/memory/subrequest limits enforced.

### What UC Does Today
UC plugins are **fully trusted**. `defineCommercePlugin()` has no capability declaration. A plugin's hooks/routes get full access to `ctx.services`, `ctx.database.db`, and can do anything. There's a `permissions` field but it's for **route-level RBAC** (actor permissions), not plugin capability scoping.

### What to Steal
1. **Add `capabilities` to `defineCommercePlugin()` manifest** — declare what the plugin needs (`read:catalog`, `write:orders`, `network:fetch`, `email:send`, `storage:read`, `storage:write`).
2. **Gate hook registration by capability** — `checkout.beforePayment` requires `write:checkout`. Enforce at registration time, not runtime.
3. **Scope the PluginContext** — only inject `ctx.services.catalog` if the plugin declared `read:catalog`. Only inject `ctx.jobs` if it declared `jobs:enqueue`.
4. **Network capability with host restrictions** — for plugins that need outbound HTTP, require explicit host declaration.
5. **Plugin storage isolation** — EmDash gives each plugin its own namespaced KV + storage collections with declared indexes. UC could add plugin-scoped storage tables (`_plugin_storage`) instead of giving plugins raw DB access.

### Why It Matters
- Marketplace trust: capability manifests let store owners evaluate plugin risk before installing.
- Multi-tenant safety: in SaaS mode, one misbehaving plugin can't access another tenant's data.
- AI agent safety: when agents install plugins, they can reason about capabilities.

---

## 2. AI-Native Architecture (HIGH PRIORITY)

### What EmDash Does
EmDash is designed as **AI-native** with three first-class integration surfaces:

1. **MCP Server (28 tools)** — Every EmDash instance exposes `/_emdash/api/mcp` with tools for content CRUD, schema management, media, search, taxonomy, menus, revisions. Uses Streamable HTTP transport, stateless mode. Auth via OAuth 2.1 + PKCE. Tools enforce RBAC + scope-based access + ownership checks.

2. **CLI (22 commands)** — `emdash content create posts --data '{"title":"Hello"}'`. Auto-publishes by default. Supports `--data`, `--file`, `--stdin`. Dev bypass for localhost. Stores credentials in `~/.config/emdash/auth.json`.

3. **Agent Skills (7 skills)** — Structured markdown with frontmatter. Skills cover CLI usage, site building, plugin creation, WordPress migration, browser testing, adversarial review. Each skill has a SKILL.md + references/ directory.

### What UC Does Today
- **MCP**: UC has `toolBuilder()` with STRAP pattern. Has ~15 core tools (catalog, orders, inventory, cart, pricing, promotions, search, webhooks). Good foundation but less granular than EmDash.
- **CLI**: UC has `@unifiedcommerce/cli` but only `api-key create`. No content management, no schema operations, no media uploads, no search.
- **Skills**: UC has one skill (`packages/skills/unified-commerce/`) with SKILL.md + 6 references. Solid but single-purpose.
- **SDK codegen**: UC has `bunx @unifiedcommerce/sdk generate` — EmDash has `emdash types`. Similar concept.

### What to Steal

#### 2a. Expand the CLI to be agent-first
The CLI should be the primary way agents interact with UC. Add commands:
```
uc catalog list --type product --limit 20 --json
uc catalog get <id-or-slug> --published
uc catalog create --data '{"name":"Widget","type":"product","price":1999}'
uc orders list --status pending --json
uc orders update-status <id> --status fulfilled
uc inventory adjust --entity-id <id> --quantity 10
uc media upload ./image.png
uc search query "blue shirt" --json
uc schema push                    # drizzle-kit push wrapper
uc types generate                 # SDK type generation
uc plugin list / install / remove
uc seed <file>                    # seed database from JSON
```

Design principles from EmDash:
- **Auto-publish by default** — `catalog create` should auto-activate, with `--draft` for draft mode.
- **JSON output** — every command supports `--json` for machine parsing.
- **Flexible input** — `--data`, `--file`, `--stdin` for agents that pipe data.
- **Dev bypass** — localhost doesn't need auth tokens (convenience for local dev).

#### 2b. Expand MCP tools to match CLI coverage
Current UC MCP tools cover basic operations. Add:
- **Media tools** — upload, list, update, delete media assets
- **Schema tools** — list entity types, get entity schema, create entity type, add field
- **Customer tools** — list, get, update customers
- **Settings tools** — read/update store configuration
- **Fulfillment tools** — create, update, track fulfillments
- **Promotion tools** — create, validate, list promotions
- **Analytics tools** — query analytics models

Each tool should enforce: RBAC role check + permission scope check + ownership check (like EmDash's defense-in-depth).

#### 2c. Multi-skill architecture
Instead of one monolithic skill, adopt EmDash's pattern:
- `skills/unified-commerce/` — main onboarding skill (current)
- `skills/building-commerce-store/` — building storefronts with UC
- `skills/creating-plugins/` — plugin development guide
- `skills/commerce-cli/` — CLI usage reference
- `skills/migrating-to-uc/` — Shopify/WooCommerce migration
- `skills/pos-setup/` — POS plugin configuration
- `skills/marketplace-setup/` — multi-vendor marketplace setup

Each skill: SKILL.md (frontmatter + overview) + references/ (detailed docs).

---

## 3. Hook System Enhancements (MEDIUM PRIORITY)

### What EmDash Does
EmDash hooks have rich configuration:
```typescript
{
  priority: 210,              // Explicit ordering (lower = first)
  timeout: 10000,             // Per-hook timeout (default 5000ms)
  dependencies: ["audit-log"],// Run after these plugins
  errorPolicy: "continue",   // Don't block on failure
  exclusive: true,           // Provider pattern (only one active)
}
```

Three execution patterns:
- **Priority pipeline** — sorted by priority, topological sort by dependencies
- **Exclusive hooks** — only one active provider (email delivery, comment moderation)
- **Middleware pipeline** — chained transformations (content:beforeSave chains output)

### What UC Does Today
UC has three layers: prepend, configured, appended. No priority numbers, no dependencies, no timeout per hook, no error policies. Before hooks must return data. After hooks are fire-and-forget.

### What to Steal
1. **Per-hook timeout** — EmDash defaults to 5s. UC has a blanket 20s. Add per-hook `timeout` config.
2. **Hook dependencies** — `dependencies: ["loyalty-plugin"]` ensures ordering without fragile layer tricks.
3. **Error policies** — `errorPolicy: "continue"` means a webhook notification failure doesn't block checkout. This is huge for reliability.
4. **Exclusive hooks** — for provider patterns like payment capture, email delivery, tax calculation. Only one plugin can be the active provider.
5. **Hook priority** — explicit numbers instead of prepend/append layers. More flexible.

---

## 4. Plugin Lifecycle Management (MEDIUM PRIORITY)

### What EmDash Does
Full plugin lifecycle: `registered → installed → active → inactive → uninstalled`. Each state transition triggers lifecycle hooks (`plugin:install`, `plugin:activate`, `plugin:deactivate`, `plugin:uninstall`). Plugins can run setup migrations on install and clean up on uninstall. Admin UI shows plugin state, marketplace browsing.

### What UC Does Today
UC plugins are config transforms — they're either in the config or not. No install/uninstall lifecycle. No plugin state management. No marketplace. Plugins are npm packages that you add to `commerce.config.ts`.

### What to Steal
1. **Plugin lifecycle hooks** — `plugin:install`, `plugin:activate`, `plugin:deactivate`, `plugin:uninstall`. Let plugins run setup (seed data, create indexes) on first use.
2. **Plugin storage** — each plugin gets isolated storage without needing its own pgTable. A `_plugin_storage` table with `(plugin_id, collection, id, data)` + declared indexes.
3. **Runtime plugin management** — install/activate/deactivate plugins without restarting the server. Store plugin state in DB, not just config.
4. **Marketplace foundation** — capability manifests enable safe marketplace browsing. Admin UI can show what each plugin requests before install.

---

## 5. Structured Content Model (LOWER PRIORITY / DIFFERENT DOMAIN)

### What EmDash Does
Content is stored as **Portable Text** (structured JSON), not HTML. Enables rendering as web, mobile, email, API without HTML parsing. The schema is **database-first** — collections and fields are defined in the DB, not in code. Admin UI creates schemas. CLI/API can modify schemas at runtime. TypeScript types are generated from the live schema.

### What UC Does Today
UC is **code-first** schema via Drizzle `pgTable`. Schema changes require code deployment + `drizzle-kit push`. This is appropriate for commerce (schema changes are rare, data integrity is critical).

### Assessment
**Don't change this.** Commerce has different requirements than CMS:
- Product schemas are more stable than content schemas
- Data integrity (foreign keys, constraints) is critical for orders/inventory
- Code-first with migrations is safer for production commerce
- UC already has `entities` config for dynamic product types

**But steal the type generation pattern**: EmDash's `emdash types` command generates TypeScript from live schema. UC's `bunx @unifiedcommerce/sdk generate` does this for the API. Consider also generating entity type interfaces from the `entities` config.

---

## 6. x402 Payment Protocol (INTERESTING / FUTURE)

### What EmDash Does
Built-in x402 support: every EmDash site can charge for content access. Bot-only mode charges AI agents, not humans. Uses HTTP 402 status code + on-chain payment settlement. Multi-chain (EVM + Solana).

### Relevance to UC
Commerce engines already handle payments. But x402 could enable:
- **API monetization** — charge per API call for third-party integrations
- **Agent commerce** — AI agents browsing/buying on behalf of users
- **Marketplace fees** — automatic payment splitting for marketplace plugin
- **Micro-transactions** — pay-per-article, pay-per-download digital goods

This is forward-looking but aligns with the "AI Native Commerce Engine" vision.

---

## 7. Conflict Detection (MEDIUM PRIORITY)

### What EmDash Does
EmDash uses **revision tokens** (`_rev`) for optimistic concurrency. Every content update must include the current revision token. If two editors edit simultaneously, the second gets a conflict error.

### What UC Does Today
No built-in conflict detection. Last-write-wins on all updates.

### What to Steal
Add revision/version fields to key tables (orders, entities, inventory). Return version in responses. Require version match on updates. This prevents:
- Two admins editing the same product simultaneously
- Race conditions on inventory updates
- Order status conflicts

Implementation: add `version integer NOT NULL DEFAULT 1` to key tables. On update: `WHERE id = ? AND version = ?`, `SET version = version + 1`. If 0 rows affected → conflict.

---

## 8. OAuth 2.1 for MCP (HIGH PRIORITY)

### What EmDash Does
Full OAuth 2.1 implementation for MCP client authorization:
- Authorization Code + PKCE flow for interactive clients
- Device Flow for CLI (`emdash login`)
- Personal Access Tokens for automation
- Discovery endpoints at `/.well-known/oauth-*`
- Scoped tokens: `content:read`, `content:write`, `schema:read`, `admin`

### What UC Does Today
UC MCP uses API keys (`x-api-key` header). Simple but limited — no scoped MCP access, no interactive auth flow for agents.

### What to Steal
Add OAuth 2.1 support for MCP:
- **Authorization Code + PKCE** — for interactive agent sessions
- **Device Flow** — for CLI-based agent workflows
- **Scoped MCP tokens** — agents get only the scopes they need
- **Discovery endpoints** — standard OAuth metadata for automatic client configuration

This is critical for the "AI Native" vision. Agents need secure, scoped access to commerce operations.

---

## Priority Matrix

| Pattern | Priority | Effort | Impact |
|---------|----------|--------|--------|
| Plugin capabilities | HIGH | Large | Security, marketplace trust, multi-tenant safety |
| Expanded CLI (agent-first) | HIGH | Medium | AI agent productivity, developer experience |
| MCP tool expansion | HIGH | Medium | AI agent coverage, competitive positioning |
| OAuth 2.1 for MCP | HIGH | Large | Secure agent access, enterprise readiness |
| Multi-skill architecture | MEDIUM | Small | Agent onboarding, discoverability |
| Hook enhancements (timeout, deps, errorPolicy) | MEDIUM | Medium | Reliability, flexibility |
| Plugin lifecycle management | MEDIUM | Large | Marketplace, runtime management |
| Conflict detection (revision tokens) | MEDIUM | Medium | Data integrity, concurrent editing |
| Plugin storage isolation | MEDIUM | Medium | Security, plugin portability |
| x402 payment protocol | LOW | Large | Future: agent commerce, API monetization |
| Database-first schema | SKIP | — | Wrong fit for commerce (code-first is correct) |

---

## 9. Entity Draft/Live + Revision System (HIGH PRIORITY)

### What EmDash Does
Every content item has `live_revision_id` and `draft_revision_id`. Full revision history stored in a `revisions` table with monotonic ULIDs. Supports:
- **Draft → Publish**: creates revision, updates `live_revision_id`, sets `published_at`
- **Unpublish**: creates draft from live, clears live, reverts to draft status
- **Scheduled publishing**: `scheduled_at` + cron job to process due items
- **Revision comparison**: `handleContentCompare()` returns live vs draft for diff view
- **Revision restore**: roll back to any historical revision, creates new revision to record the action
- **Revision pruning**: keeps most recent N revisions, deletes older ones

### What UC Does Today
Entities have `status` (draft/active/archived/discontinued) but no revision history. Editing a product directly mutates the row. No way to stage changes, review before publishing, compare versions, or roll back.

### What to Steal
1. **Add revision tracking to sellable_entities**: `live_revision_id`, `draft_revision_id`, `version` columns
2. **Revision table**: `id`, `entity_id`, `collection`, `data` (JSON snapshot), `author_id`, `created_at`
3. **Draft/Live API**: `POST /api/catalog/entities/{id}/publish`, `/unpublish`, `/schedule`, `/discard-draft`
4. **Revision API**: `GET /api/catalog/entities/{id}/revisions`, `/compare`, `/restore/{revisionId}`
5. **MCP tools**: `entity_publish`, `entity_schedule`, `entity_compare_draft`, `entity_restore`
6. **Scheduled publishing**: use existing job queue to process `scheduled_at` items

### Why It Matters for Commerce
- Merchants stage seasonal catalog changes weeks in advance
- Marketing teams review product edits before publishing
- Compliance requires audit trail of what changed and when
- AI agents need draft → review → publish workflows
- Rollback when a bulk import goes wrong

---

## 10. Plugin Admin UI Contribution System (HIGH PRIORITY)

### What EmDash Does
Plugins can contribute to the admin UI via structured declarations:
```typescript
admin: {
  settingsSchema: { apiKey: { type: "string", secret: true }, mode: { type: "select", options: ["live", "test"] } },
  pages: [{ path: "dashboard", label: "Dashboard", icon: "chart" }],
  widgets: [{ id: "stats", title: "Loyalty Stats", size: "half" }],
  portableTextBlocks: [{ type: "product-card", label: "Product Card" }],
  fieldWidgets: [{ name: "color-picker", label: "Color Picker", fieldTypes: ["string"] }],
}
```
Admin UI dynamically imports plugin components. Settings auto-generate forms from schema. Dashboard widgets render in a grid layout.

### What UC Does Today
UC plugins can add API routes, hooks, MCP tools, and analytics models. But they have **zero admin UI presence**. A loyalty plugin creates `/api/loyalty/*` routes but the merchant has no way to configure or view it in the admin panel. No dashboard widgets, no settings UI, no custom pages.

### What to Steal
1. **Plugin settings schema** — Zod schema declaration → auto-generated admin settings form. Stored in plugin KV storage.
2. **Plugin admin pages** — declare pages with path/label/icon → admin renders them at `/admin/plugins/{pluginId}/{page}`
3. **Dashboard widgets** — declare widget ID/title/size → admin dashboard renders widget grid
4. **Custom field editors** — register field editor widgets for specific field types
5. **React component registration** — plugins export React components that the admin dynamically imports

### Why It Matters
- Plugins without admin UI are invisible to non-technical merchants
- Marketplace plugins need visual settings/configuration
- Dashboard widgets give plugins immediate visual presence
- Critical for POS, loyalty, analytics plugins

---

## 11. Per-Plugin Storage (KV + Collections) (MEDIUM PRIORITY)

### What EmDash Does
Plugins declare storage collections in their manifest:
```typescript
storage: {
  cache: { indexes: ["key"], uniqueIndexes: [["key"]] },
  deliveries: { indexes: ["timestamp", "webhookUrl", "status", ["webhookUrl", "status"]] }
}
```
All stored in a single `_plugin_storage` table with `(plugin_id, collection, id, data JSON, updated_at)`. Indexes created automatically from declarations. Plugins access via:
```typescript
await ctx.storage.deliveries.get(id)
await ctx.storage.deliveries.query({ where: { status: "success" }, limit: 20 })
await ctx.storage.deliveries.count({ status: "failed" })
```
Plus a simpler KV namespace: `ctx.kv.set("key", value)`, `ctx.kv.get("key")`.

### What UC Does Today
Every plugin that needs storage must:
1. Define a Drizzle `pgTable` in `schema/`
2. Add it to `schema: () => ({ myTable })` in the plugin manifest
3. Update `drizzle.config.ts` to include the schema file
4. Run `bunx drizzle-kit push`

This is 4 steps of boilerplate for what's often just "I need to store some JSON keyed by ID."

### What to Steal
1. **`_plugin_storage` table**: `(plugin_id, collection, id, data JSONB, updated_at)`
2. **Plugin KV namespace**: `ctx.kv.set("settings", { apiKey: "..." })` / `ctx.kv.get("settings")`
3. **Collection API**: `ctx.storage.collection("deliveries").query({ where, limit, cursor })`
4. **Auto-index creation**: from manifest declarations
5. **Plugin-scoped**: all queries include `WHERE plugin_id = ?`

### Why It Matters
- Eliminates 90% of plugin schema boilerplate
- Plugins no longer need to touch `drizzle.config.ts`
- Safer: plugins can't accidentally modify core tables
- Essential for marketplace: plugins can be installed without schema changes

---

## 12. Zod-Based Plugin Manifest Validation (HIGH PRIORITY, LOW EFFORT)

### What EmDash Does
Plugin manifests validated with Zod at parse time:
```typescript
const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().refine(isValidSemver),
  capabilities: z.array(z.enum([...validCapabilities])),
  hooks: z.array(z.union([z.string(), hookEntrySchema])),
  routes: z.array(z.union([z.string(), routeEntrySchema])),
  storage: z.record(storageCollectionSchema),
});
```
Invalid manifests fail immediately with clear error messages.

### What UC Does Today
`defineCommercePlugin()` uses TypeScript interface types only. No runtime validation. A malformed plugin (bad ID format, invalid hook key, typo in permission) fails silently at registration or crashes at runtime.

### What to Steal
Add Zod validation to `defineCommercePlugin()`:
- Validate `id` format: `/^[a-z0-9-]+$/`
- Validate `version` is semver
- Validate hook keys against known list
- Validate permission format: `resource:action` pattern
- Validate schema table names don't collide with core tables
- Throw descriptive errors at registration time

---

## 13. Per-Plugin Cron/Job Scheduling API (MEDIUM PRIORITY)

### What EmDash Does
Plugins schedule tasks programmatically:
```typescript
await ctx.cron.schedule("daily-sync", {
  pattern: "0 2 * * *",  // 2 AM daily
  data: { storeId: "..." }
});
await ctx.cron.list();
await ctx.cron.cancel("daily-sync");
```
Cron executor claims overdue tasks, invokes per-plugin cron hook, handles recurring/one-shot.

### What UC Does Today
Jobs are defined at config level:
```typescript
jobs: {
  tasks: [{ slug: "my-task", handler: async ({ input }) => { ... } }],
  autorun: { enabled: true }
}
```
Plugins can `enqueue()` tasks but can't define recurring schedules. Recurring jobs require external cron.

### What to Steal
1. **Per-plugin scheduling API**: `ctx.jobs.schedule(slug, { pattern, data })`
2. **Cron parsing**: interpret standard cron patterns, compute next run
3. **One-shot scheduling**: `ctx.jobs.scheduleOnce(slug, { runAt: Date, data })`
4. **Task management**: `ctx.jobs.list()`, `ctx.jobs.cancel(slug)`
5. **Store in commerceJobs**: add `cron_pattern`, `next_run_at`, `plugin_id` columns

---

## 14. Seed/Import System (MEDIUM PRIORITY)

### What EmDash Does
Declarative JSON seed files:
```json
{
  "collections": [{ "slug": "products", "name": "Products" }],
  "content": {
    "products": [
      { "seedId": "widget-1", "title": "Blue Widget", "price": 1999,
        "featured_image": { "$media": { "url": "https://...", "alt": "Widget" } } }
    ]
  }
}
```
Features:
- **$ref syntax**: cross-reference between entries (`"category": { "$ref": "electronics" }`)
- **$media syntax**: download external media, upload to storage, create media record
- **Conflict modes**: skip (default), update, error
- **Ordered application**: settings → collections → taxonomies → content → menus
- **CLI command**: `emdash seed seed.json`

### What UC Does Today
UC has import adapters (Shopify, WooCommerce, flat file) but no unified seed system. Each import adapter is custom. No $ref cross-referencing. No declarative demo data.

### What to Steal
1. **Unified seed command**: `uc seed demo-data.json`
2. **$ref cross-references**: link entities by seed-local ID, resolve to real IDs
3. **Conflict modes**: skip, update, error for idempotent seeding
4. **$media syntax**: fetch and import external images
5. **Ordered application**: respect entity dependencies
6. **CLI integration**: `uc seed`, `uc export-seed`

### Why It Matters
- Demo/storefront starters need pre-populated data
- Migration from any platform becomes seed → push
- Test fixtures become declarative JSON
- AI agents can generate seed files to set up stores

---

## 15. Plugin Settings Schema + Auto-Generated UI (HIGH PRIORITY, LOW EFFORT)

### What EmDash Does
```typescript
admin: {
  settingsSchema: {
    apiKey: { type: "string", secret: true, label: "API Key", required: true },
    mode: { type: "select", options: ["live", "test"], default: "test" },
    webhookUrl: { type: "string", label: "Webhook URL" },
    syncInterval: { type: "number", label: "Sync Interval (min)", default: 30 },
    enabled: { type: "boolean", label: "Enable Sync", default: true },
  }
}
```
Admin auto-generates settings form. Values stored in plugin KV. Plugin accesses via `ctx.settings.get("apiKey")`.

### What UC Does Today
Plugins have no built-in settings mechanism. Each plugin implements its own configuration storage and UI.

### What to Steal
1. **Settings schema in plugin manifest**: Zod-based or declarative
2. **Auto-generated admin settings page**: form with validation from schema
3. **Plugin settings API**: `ctx.settings.get("key")`, `ctx.settings.getAll()`
4. **Storage in `_plugin_storage`** or dedicated `_plugin_settings` table
5. **Secret fields**: stored encrypted, masked in API responses

### Why It Matters
- Every non-trivial plugin needs configuration (API keys, modes, URLs)
- Currently every plugin reinvents this
- Auto-generated UI means plugins get settings pages for free
- Critical for marketplace: users configure plugins without code

---

## 16. Granular Error Code Registry (MEDIUM PRIORITY, LOW EFFORT)

### What EmDash Does
300+ specific error codes organized by domain:
- `CONTENT_CREATE_ERROR`, `CONTENT_UPDATE_ERROR`, `CONTENT_PUBLISH_ERROR`
- `COLLECTION_EXISTS`, `FIELD_EXISTS`, `RESERVED_SLUG`
- `PLUGIN_ID_CONFLICT`, `CAPABILITY_ESCALATION`
- `UPLOAD_ERROR`, `STORAGE_NOT_CONFIGURED`
- Consistent HTTP status mapping

### What UC Does Today
~10 error classes: `CommerceNotFoundError`, `CommerceValidationError`, `CommerceForbiddenError`, etc. Generic — "NOT_FOUND" doesn't tell you if it's a product, order, or cart that wasn't found.

### What to Steal
1. **Domain-specific error codes**: `CATALOG_ENTITY_NOT_FOUND`, `CHECKOUT_CART_EMPTY`, `INVENTORY_INSUFFICIENT_STOCK`, `PAYMENT_AUTHORIZATION_FAILED`, `ORDER_INVALID_TRANSITION`
2. **Consistent status mapping**: each error code maps to exactly one HTTP status
3. **Machine-readable**: agents can programmatically understand what went wrong
4. **Error code registry**: centralized enum/map that documents all possible errors

---

## 17. Entity Translation Groups (LOWER PRIORITY)

### What EmDash Does
Content can have locale variants via `locale` + `translation_group` columns. Non-translatable fields sync across all variants. API returns translation siblings.

### What UC Does Today
UC has `sellableAttributes` per locale (translatable title/description). But no translation group concept — each entity variant is independent. No cross-locale field sync.

### What to Steal
- Add `translation_group` and `locale` to `sellable_entities`
- Sync non-translatable fields (price, weight, SKU) across translation group
- API to list translations: `GET /api/catalog/entities/{id}/translations`
- MCP tool for translation management

---

## Updated Priority Matrix

| Pattern | Priority | Effort | Impact |
|---------|----------|--------|--------|
| Plugin capabilities (from analysis) | HIGH | Large | Security, marketplace trust |
| Expanded CLI (from analysis) | HIGH | Medium | AI agent productivity |
| MCP tool expansion (from analysis) | HIGH | Medium | AI agent coverage |
| OAuth 2.1 for MCP (from analysis) | HIGH | Large | Secure agent access |
| **Entity draft/live + revisions** | **HIGH** | **Medium** | **Staging workflows, audit trail, rollback** |
| **Plugin admin UI contributions** | **HIGH** | **Large** | **Plugin visibility, marketplace UX** |
| **Zod manifest validation** | **HIGH** | **Small** | **Reliability, developer experience** |
| **Plugin settings + auto-UI** | **HIGH** | **Small** | **Plugin configuration, marketplace** |
| **Per-plugin storage (KV)** | **MEDIUM** | **Medium** | **Plugin portability, boilerplate reduction** |
| Hook enhancements (from analysis) | MEDIUM | Medium | Reliability, flexibility |
| Plugin lifecycle (from analysis) | MEDIUM | Large | Marketplace management |
| **Per-plugin cron scheduling** | **MEDIUM** | **Medium** | **Recurring integrations** |
| **Seed/import system** | **MEDIUM** | **Medium** | **Demos, migrations, test fixtures** |
| Conflict detection (from analysis) | MEDIUM | Medium | Data integrity |
| **Granular error codes** | **MEDIUM** | **Small** | **Debugging, agent error handling** |
| Multi-skill architecture (from analysis) | MEDIUM | Small | Agent onboarding |
| **Entity translation groups** | **LOW** | **Medium** | **Multi-locale commerce** |
| x402 payment protocol (from analysis) | LOW | Large | Future: agent commerce |

---

## What UC Already Does Better

Important to acknowledge — UC isn't behind everywhere:

1. **Commerce domain model** — UC has a rich commerce-specific domain (orders, inventory, pricing, promotions, fulfillment, shipping, checkout pipeline). EmDash is a generic CMS.

2. **Result<T> error handling** — UC's explicit Result types are more disciplined than EmDash's `ApiResponse<T>` pattern.

3. **SDK typed client** — UC's `createClient<paths>()` with openapi-typescript codegen is elegant. EmDash has something similar but UC's approach is more established.

4. **Plugin dependency tracking** — UC's `requires: ["other-plugin"]` with production throws / dev warns is a good pattern.

5. **Organization scoping** — UC's built-in multi-tenancy via `organizationId` on every table is more mature than EmDash's single-site model.

6. **Repository factory** — UC's auto-generated CRUD from Drizzle schema eliminates boilerplate.

7. **Checkout pipeline** — UC's fixed 9-step checkout with compensation chain (saga pattern) is sophisticated commerce infrastructure that EmDash doesn't need to solve.

8. **Analytics layer** — UC has Cube.js integration with semantic models. EmDash has no analytics.
