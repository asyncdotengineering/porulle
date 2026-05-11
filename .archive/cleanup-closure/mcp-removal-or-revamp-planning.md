# MCP Removal or Revamp — Architectural Decision Document

## 1. Surface Area Inventory

### 1a. Directly-MCP (core `interfaces/mcp/` directory)

| File | LOC | Summary |
|---|---|---|
| `interfaces/mcp/transport.ts` | 168 | Streamable HTTP transport, auth gate, per-request `buildMcpServer`, plugin tool bridge |
| `interfaces/mcp/server.ts` | 47 | Core tool + resource registration on `McpServer` instance |
| `interfaces/mcp/agent-prompt.ts` | 174 | System prompts for AI agents (full + compact) |
| `interfaces/mcp/context-enrichment.ts` | 180 | Response enrichment: adds `_context` (summaries, related queries, stock status) |
| `interfaces/mcp/tool-builder.ts` | 261 | STRAP-pattern fluent builder for plugin MCP tools |
| `interfaces/mcp/tools/registry.ts` | 101 | `defineTool`, `ToolDefinition<T>`, `registerToolsOnServer` — handler signature `(args, kernel)` |
| `interfaces/mcp/tools/index.ts` | 22 | Aggregates 9 tool modules into `coreTools[]` |
| `interfaces/mcp/tools/catalog.ts` | 300 | `catalog_search`, `catalog_create`, `catalog_get`, `catalog_manage` |
| `interfaces/mcp/tools/cart.ts` | 57 | `cart_create`, `cart_add_item` |
| `interfaces/mcp/tools/orders.ts` | 104 | `order_get`, `order_list`, `order_change_status` |
| `interfaces/mcp/tools/inventory.ts` | 167 | `inventory_check`, `inventory_manage` |
| `interfaces/mcp/tools/pricing.ts` | 94 | `pricing_manage` |
| `interfaces/mcp/tools/promotions.ts` | 106 | `promotions_manage` |
| `interfaces/mcp/tools/search.ts` | 42 | `search` (full-text + suggest) |
| `interfaces/mcp/tools/webhooks.ts` | 55 | `webhooks_manage` |
| `interfaces/mcp/tools/analytics.ts` | 76 | `analytics_query`, `analytics_meta` |
| **Total directly-MCP** | **1,954** | |

### 1b. Indirectly-Aware (outside `mcp/` but containing MCP-specific code)

| File | LOC | MCP-specific lines | Summary |
|---|---|---|---|
| `runtime/kernel.ts` | 190 | ~25 | `mcpTools` array, `getMCPActor()` hardcoded actor, `config.mcpTools` evaluation |
| `runtime/kernel-types.ts` | 121 | ~12 | `Kernel.mcpTools`, `Kernel.getMCPActor()` type definitions |
| `runtime/server.ts` | 482 | ~3 | Route mount: `app.route("/api/mcp", createMCPHandler(kernel))` (line 311) |
| `config/types.ts` | 420 | ~20 | `MCPTool` interface (line 280), `MCPResource` (line 287), `config.mcp` schema (line 334), `config.mcpTools` (line 383) |
| `kernel/plugin/manifest.ts` | 345 | ~30 | `mcpTools` field on plugin manifest, chaining logic (line 142, 299–313) |
| `kernel/local-api.ts` | 188 | ~1 | Comment referencing `mcpTools` |
| `index.ts` (exports) | 219 | ~4 | Exports `toolBuilder`, `MCPTool`, `MCPResource`, `COMMERCE_AGENT_SYSTEM_PROMPT*` |
| `test/mcp.test.ts` | 172 | 172 | MCP protocol compliance test suite |
| `test/phase5-search.test.ts` | 193 | ~5 | Imports `createMCPHandler` for search-via-MCP test |
| `test-utils/create-test-config.ts` | 189 | ~3 | `ai_agent` role with `mcp:access` permission |
| **Total indirectly-aware** | **2,519** | **~275 MCP-specific** | |

### 1c. Plugin MCP Tools (consumers of `toolBuilder` and `mcpTools` API)

| File | LOC | Summary |
|---|---|---|
| `plugin-marketplace/src/mcp-tools.ts` | 188 | Vendor, suborder, dispute, payout, commission, RFQ tools |
| `plugin-warehouse/src/mcp-tools.ts` | 89 | Transfer, wastage, reconciliation tools |
| `plugin-production/src/mcp-tools.ts` | 80 | Manufacturing run tools |
| `plugin-procurement/src/mcp-tools.ts` | 80 | Purchase order, supplier tools |
| ~10 other plugins `index.ts` | ~120 | `mcpTools` declarations using `toolBuilder` (loyalty, reviews, gift-cards, appointments, wishlist, notifications, POS, POS-restaurant) |
| **Total plugin MCP** | **~557** | |

### 1d. Leaf Consumers (docs, examples, templates)

| File | LOC | Summary |
|---|---|---|
| `apps/docs/reference/mcp-tools.mdx` | 483 | Full MCP tool reference doc |
| `apps/docs/guides/ai-agents.mdx` | 98 | AI agent connection guide |
| `apps/docs/guides/authentication.mdx` | 333 | References `mcp:access` permission (line 314) |
| `apps/docs/explanation/plugin-architecture.mdx` | 308 | References `mcpTools` pattern |
| `apps/docs/tutorials/build-a-plugin.mdx` | 445 | Tutorial includes `mcpTools` / `toolBuilder` |
| `apps/docs/reference/plugins.mdx` | 933 | Plugin reference with MCP tools |
| `apps/store-example/commerce.config.ts` | 179 | `ai_agent` role with `mcp:access` (line 120, 129) |
| `packages/cli/templates/starter/commerce.config.ts` | 80 | `ai_agent` role with `mcp:access` (line 58, 67) |
| **Total leaf consumers** | **~2,859** | |

### 1e. npm Dependency Weight

- `@modelcontextprotocol/sdk@^1.29.0` — direct dependency of `packages/core`
- Transitive deps: `ajv`, `ajv-formats`, `eventsource`, `cross-spawn`, `content-type`, `cors`, `@hono/node-server`
- Approximate installed size: ~2 MB (SDK + transitive)
- Used only in `transport.ts` (3 imports: `McpServer`, `WebStandardStreamableHTTPServerTransport`)

### 1f. Summary Totals

| Category | LOC |
|---|---|
| Directly-MCP (deletable as a unit) | 1,954 |
| Indirectly-aware (MCP-specific lines) | ~275 of 2,519 |
| Plugin MCP tools | ~557 |
| Leaf consumers (docs, examples) | ~2,859 |
| **Total MCP surface** | **~5,645** |

---

## 2. Architectural Debt Summary

### Hole 1: Tool handler signature has no actor

**Location:** `interfaces/mcp/tools/registry.ts:18`
```ts
handler: (args: z.infer<TInput>, kernel: Kernel) => Promise<unknown>;
```
**Why structural:** The SDK's `registerTool` callback signature is `(args) => result`. The kernel is captured at registration time (closure), but the per-request actor is not available inside that closure. To thread actor in, either (a) the handler signature must change to accept a context object, which means every tool must change, or (b) the transport must set a per-request kernel wrapper — which doesn't exist in the current architecture.

### Hole 2: `getMCPActor()` returns a hardcoded synthetic actor

**Location:** `runtime/kernel.ts:149–169`
```ts
getMCPActor() {
  return { type: "api_key", userId: "mcp-agent", organizationId: DEFAULT_ORG_ID, ... };
}
```
**Why structural:** This is a method on the kernel singleton, not per-request state. Every MCP request gets the same actor regardless of who authenticated. The `transport.ts` auth gate (line 97) reads `c.var.actor` from the Hono context and checks `mcp:invoke` permission, but then discards it — the tool handlers call `kernel.getMCPActor()` which returns the synthetic actor with `DEFAULT_ORG_ID`. In multi-tenant deployments, this is a cross-tenant data leak vector.

### Hole 3: Registration is one-shot at boot, not request-scoped

**Location:** `interfaces/mcp/transport.ts:43–68` (`buildMcpServer`)
**Why structural:** `buildMcpServer` is called per-request (good), but `registerCoreTools(server, kernel)` registers all tools regardless of the caller's permissions. There is no mechanism to filter tools by actor permissions. A user with `catalog:read` only would still see (and attempt to call) `webhooks_manage`, `inventory_manage`, etc. The dangerous-tool filter (`enableDangerousTools`) is config-level, not actor-level.

### Hole 4: Webhook tool calls services with `null` actor

**Location:** `interfaces/mcp/tools/webhooks.ts:39,46`
```ts
kernel.services.webhooks.listEndpoints(null);
kernel.services.webhooks.deleteEndpoint(endpointId, null);
```
**Why structural:** The comment in the file (lines 32–38) acknowledges this: "MCP tool registration is one-shot at boot; the McpServer SDK does not thread per-request actor into the handler." With `auth.strictOrgResolution=true`, this will fail closed (error), which is correct but means the tool is broken in strict mode. In non-strict mode, it falls through to `DEFAULT_ORG_ID` — potentially leaking cross-tenant webhook endpoints.

### Hole 5: No per-tool permission enforcement

**Location:** `interfaces/mcp/transport.ts:119`
```ts
if (!perms.includes("*:*") && !perms.includes("mcp:*") && !perms.includes("mcp:invoke"))
```
**Why structural:** The gate is binary: you either have `mcp:invoke` (access to ALL tools) or you don't. There is no `catalog_manage` requires `catalog:update` mapping. A caller with `mcp:invoke` and only `catalog:read` can still invoke `inventory_adjust`, `order_change_status`, `webhooks_manage`. The service layer does its own permission check, but the MCP layer doesn't gate based on the tool's semantic permission requirements before dispatch.

### Hole 6: Plugin tool handlers have no actor at all

**Location:** `interfaces/mcp/transport.ts:24–27`
```ts
async (args: Record<string, unknown>) => {
  const orgId = kernel.getMCPActor().organizationId;
  const result = await runWithPluginDatabaseScope(orgId, () => ...);
```
**Why structural:** Plugin tools use `kernel.getMCPActor().organizationId` for DB scoping — same hardcoded synthetic actor as hole 2. Plugin tools that call services requiring actor will either fail or operate with elevated synthetic permissions.

---

## 3. Option A — Remove MCP Entirely

### Files to Delete

| File | LOC |
|---|---|
| `packages/core/src/interfaces/mcp/` (entire directory — 16 files) | 1,954 |
| `packages/core/test/mcp.test.ts` | 172 |
| `packages/plugins/plugin-marketplace/src/mcp-tools.ts` | 188 |
| `packages/plugins/plugin-warehouse/src/mcp-tools.ts` | 89 |
| `packages/plugins/plugin-production/src/mcp-tools.ts` | 80 |
| `packages/plugins/plugin-procurement/src/mcp-tools.ts` | 80 |
| **Total deletable** | **2,563** |

### Imports / Exports to Remove

1. **`packages/core/src/index.ts`** — Remove lines 5–6 (`MCPTool`, `MCPResource` type exports), line 20 (`toolBuilder`), lines 194–196 (`COMMERCE_AGENT_SYSTEM_PROMPT*`).
2. **`packages/core/src/runtime/server.ts:12`** — Remove `import { createMCPHandler }` and line 311 (`app.route("/api/mcp", ...)`).

### Config / Type Changes

1. **`packages/core/src/config/types.ts`** — Remove `MCPTool` interface (line 280), `MCPResource` interface (line 287), `config.mcp` schema (line 334), `config.mcpTools` field (line 383).
2. **`packages/core/src/runtime/kernel.ts`** — Remove `mcpTools` array (line 63), `getMCPActor()` method (lines 149–169), `config.mcpTools` evaluation (lines 182–187). Remove `MCPTool` import (line 1).
3. **`packages/core/src/runtime/kernel-types.ts`** — Remove `mcpTools` and `getMCPActor()` from `Kernel` interface (lines 61, 64–73). Remove `MCPTool` import (line 3).
4. **`packages/core/src/kernel/plugin/manifest.ts`** — Remove `mcpTools` field (line 142), chaining logic (lines 299–313). Remove `MCPTool` import (line 15).

### Permission Constants

Remove all references to `mcp:invoke`, `mcp:*`, `mcp:access` from:
- `packages/core/src/runtime/kernel.ts:166`
- `packages/core/src/interfaces/mcp/transport.ts` (deleted)
- `packages/core/src/test-utils/create-test-config.ts:98`

### package.json Dep Removal

- Remove `"@modelcontextprotocol/sdk": "^1.27.1"` from `packages/core/package.json:49`
- Run `bun install` to update lockfile — removes SDK + transitive deps (~2 MB)

### Plugin Changes

Each plugin with `mcpTools` in its manifest must remove that field:
- `plugin-marketplace` — remove `mcpTools` from manifest, delete `mcp-tools.ts`
- `plugin-warehouse` — same
- `plugin-production` — same
- `plugin-procurement` — same
- `plugin-loyalty`, `plugin-reviews`, `plugin-gift-cards`, `plugin-appointments`, `plugin-wishlist`, `plugin-notifications`, `plugin-pos`, `plugin-pos-restaurant` — remove `mcpTools` field from manifest

### Docs to Delete / Update

- **Delete:** `apps/docs/content/docs/reference/mcp-tools.mdx` (483 lines)
- **Delete:** `apps/docs/content/docs/guides/ai-agents.mdx` (98 lines)
- **Update:** `apps/docs/content/docs/guides/authentication.mdx` — remove `mcp:access` references
- **Update:** `apps/docs/content/docs/explanation/plugin-architecture.mdx` — remove `mcpTools` section
- **Update:** `apps/docs/content/docs/tutorials/build-a-plugin.mdx` — remove `mcpTools` / `toolBuilder` section
- **Update:** `apps/docs/content/docs/reference/plugins.mdx` — remove MCP tools references
- **Update:** `apps/docs/content/docs/reference/configuration.mdx` — remove `config.mcp` schema

### Examples to Update

- `apps/store-example/commerce.config.ts:120–130` — remove `ai_agent` role or remove `mcp:access` from its permissions
- `packages/cli/templates/starter/commerce.config.ts:58–68` — same

### Commit Plan

1. **Commit 1:** Delete `packages/core/src/interfaces/mcp/` directory + `packages/core/test/mcp.test.ts`
2. **Commit 2:** Remove MCP imports from `server.ts`, `kernel.ts`, `kernel-types.ts`, `config/types.ts`, `index.ts`, `plugin/manifest.ts`
3. **Commit 3:** Remove `getMCPActor()`, `mcpTools` array, `config.mcpTools` evaluation from kernel
4. **Commit 4:** Delete plugin `mcp-tools.ts` files, remove `mcpTools` from all plugin manifests
5. **Commit 5:** Remove `@modelcontextprotocol/sdk` from `package.json`, update lockfile
6. **Commit 6:** Update docs — delete `mcp-tools.mdx` and `ai-agents.mdx`, update other docs
7. **Commit 7:** Update `store-example` and `starter` template configs

### Risk

- **Any adopter using `config.mcpTools` or `toolBuilder`** will have a compile-time break. The `MCPTool` and `MCPResource` types are exported from the public API.
- **Any adopter with `ai_agent` role** will have unused permissions — harmless but messy.
- **The `COMMERCE_AGENT_SYSTEM_PROMPT`** is exported and may be used outside MCP (e.g., in a custom agent integration). Consider keeping it as a general-purpose export even after MCP removal.

### Effort Estimate

7 commits, ~1–2 engineer-days for a careful pass with type-checking and test verification.

---

## 4. Option B — Revamp MCP

### Handler Signature Redesign

Change from:
```ts
handler: (args: z.infer<TInput>, kernel: Kernel) => Promise<unknown>;
```
To:
```ts
handler: (args: z.infer<TInput>, ctx: McpToolContext) => Promise<unknown>;

interface McpToolContext {
  kernel: Kernel;
  actor: Actor;
  orgId: string;
  permissions: string[];
  audit: AuditService;
  tx?: DrizzleTransaction;
}
```

This threads the real authenticated actor (from `c.var.actor` in the transport) into every tool handler. The `transport.ts` already extracts the actor; it just needs to pass it through to `buildMcpServer` and into the tool registration.

### Registration Model: Per-Request Filtering

**Pick: Static registration + runtime permission narrowing.**

Reason: Per-request tool list would require building a new `McpServer` per call with different tools — the SDK doesn't support this efficiently. Instead, register all tools once, but wrap each handler with a permission gate that checks the actor's permissions against the tool's required permissions before dispatching.

Implementation:
1. Add a `requiredPermissions: string[]` field to `ToolDefinition`.
2. In `registerToolsOnServer`, wrap each handler: check `ctx.permissions` includes all of `tool.requiredPermissions`. If not, return a structured error.
3. This means `catalog_manage` requires `catalog:update`, `webhooks_manage` requires `webhooks:manage`, etc.

### Auth Model: Two-Layer

1. **Layer 1 (existing):** `mcp:invoke` permission gates the entire MCP endpoint — unchanged.
2. **Layer 2 (new):** Each tool declares `requiredPermissions`. The tool dispatch layer checks actor permissions before calling the handler. This makes it impossible for a tool to slip through without the right permission.

### Audit Model

Every tool call writes an audit row via `ctx.audit.record()`:
```ts
await ctx.audit.record({
  actor: ctx.actor,
  action: `mcp:${tool.name}`,
  entity: { type: "mcp_tool_call", id: crypto.randomUUID() },
  metadata: { args: sanitizedArgs, result: "success" | "error" },
});
```

### Transport Fix

The Hono integration already works (the `c.var.actor` is extracted at line 97 of `transport.ts`). The fix is to pass that actor into `buildMcpServer` and then into tool registration:

```ts
// transport.ts — currently:
const server = buildMcpServer(kernel);
// Becomes:
const server = buildMcpServer(kernel, actor);
```

Then `buildMcpServer` passes actor to `registerCoreTools(server, kernel, actor)` and `registerPluginTool(server, tool, kernel, actor)`.

### Tool-Set Review

| Tool | Verdict | Reasoning |
|---|---|---|
| `catalog_search`, `catalog_get` | **Keep** | Read-only, safe for LLM-driven flows |
| `catalog_create`, `catalog_manage` | **Keep** | Requires `catalog:create`/`catalog:update` — gated by new permission model |
| `inventory_check` | **Keep** | Read-only |
| `inventory_manage` | **Keep** | Requires `inventory:adjust` — gated. Dangerous flag stays. |
| `cart_create`, `cart_add_item` | **Keep** | Core shopping flow |
| `order_get`, `order_list` | **Keep** | Read-only |
| `order_change_status` | **Keep** | Requires `orders:update` — dangerous flag stays |
| `pricing_manage` | **Keep** | Requires `pricing:write` |
| `promotions_manage` | **Keep** | Requires `promotions:write` |
| `search` | **Keep** | Read-only |
| `analytics_query`, `analytics_meta` | **Keep** | Read-only |
| `webhooks_manage` | **Cut or opt-in only** | Too privileged for LLM-driven flows without explicit org-scoped opt-in. Cross-tenant risk is highest here. Consider moving to REST-only. |

**Recommendation:** Cut `webhooks_manage` from the default tool set. If an adopter wants LLM-driven webhook management, they can re-add it via `enableDangerousTools` after understanding the risk.

### Plugin `toolBuilder` API

The `toolBuilder` API (STRAP pattern) is well-designed and should be preserved. The `ActionHandlerContext` needs updating:

```ts
interface ActionHandlerContext {
  services: Record<string, unknown>;
  db: unknown;
  logger: Logger;
  actor: Actor;        // NEW
  orgId: string;       // NEW
  permissions: string[]; // NEW
}
```

### Test Overhaul

1. Replace `x-test-actor` header hack with real session simulation: create a test API key, authenticate through the full `/api/auth` flow, get a session token.
2. Add permission-narrowing tests: actor with only `catalog:read` cannot invoke `catalog_manage`.
3. Add audit trail tests: every tool call produces an audit row.
4. Add org-scoping tests: multi-tenant scenario where actor for org A cannot see org B's data.

### Docs Rewrite

- `ai-agents.mdx` — rewrite for the new permission model, document tool-specific permissions
- `mcp-tools.mdx` — update with `requiredPermissions` per tool
- `authentication.mdx` — document the two-layer auth model
- `build-a-plugin.mdx` — update `toolBuilder` API with new context fields

### Commit Plan

1. **Commit 1:** Add `McpToolContext` type, update `ToolDefinition.handler` signature
2. **Commit 2:** Update `transport.ts` to pass actor into `buildMcpServer`, thread through registration
3. **Commit 3:** Add `requiredPermissions` to all 15 tool definitions
4. **Commit 4:** Implement permission-narrowing wrapper in `registerToolsOnServer`
5. **Commit 5:** Implement audit logging in tool dispatch
6. **Commit 6:** Remove `getMCPActor()`, replace all call sites with `ctx.actor`
7. **Commit 7:** Fix `webhooks_manage` — cut from default set or make opt-in
8. **Commit 8:** Update `toolBuilder` API with new context fields
9. **Commit 9:** Update all plugin `mcp-tools.ts` files for new context
10. **Commit 10:** Test overhaul — real session sim, permission narrowing, audit, org scoping
11. **Commit 11:** Docs rewrite (ai-agents, mcp-tools, authentication, build-a-plugin)
12. **Commit 12:** Update store-example and starter template configs

### Risk

- **Breaking change for all 14 plugins** that use `mcpTools` — every plugin's handler signature changes.
- **SDK churn** — `@modelcontextprotocol/sdk` is at v1.29.0 and evolving rapidly. Any SDK update could break the transport layer.
- **Adopter break** — anyone using `kernel.getMCPActor()` directly (exported via `Kernel` type) will need to update.
- **Test coverage** — the x-test-actor hack currently makes the test suite pass. Removing it without real session simulation will break CI.

### Effort Estimate

12 commits, ~4–6 engineer-days. The handler-signature change is a cascade — every tool handler, every plugin, every test must update. The test overhaul is the highest-risk piece.

---

## 5. Decision Matrix

| Axis | Remove (A) | Revamp (B) |
|---|---|---|
| **LOC removed / changed** | ~2,563 deleted + ~275 changed in indirectly-aware files | ~1,954 changed + ~275 changed in indirectly-aware files + ~557 changed in plugins |
| **External adopter impact** | Compile-time break for anyone using `MCPTool`, `toolBuilder`, `config.mcpTools`, `getMCPActor`, `COMMERCE_AGENT_SYSTEM_PROMPT`. No runtime data loss. | Compile-time break for plugin authors (handler signature change). All 14 plugins must update. Adopters using `getMCPActor()` must refactor. |
| **Implementation cost (engineer-days)** | 1–2 days (7 commits) | 4–6 days (12 commits) |
| **Maintenance cost (ongoing)** | Zero — entire subsystem gone | Moderate — SDK dependency churn, new tools need `requiredPermissions` + audit wiring, plugin authors need context fields |
| **Strategic value** | Framework becomes purely headless-commerce REST. AI agent integrators bring their own MCP layer (standard pattern: "your MCP server, our REST API"). Simpler security model. | Framework offers first-class MCP with per-tool permissions, actor threading, and audit. Competitive differentiator for AI-native commerce. But adds ongoing maintenance and SDK coupling. |
| **Security exposure if status quo remains** | N/A (removing removes the surface) | N/A (revamp fixes the holes) |
| **Security exposure if option chosen** | Zero MCP attack surface. Clean. | MCP surface remains but is properly secured. New attack surface: per-tool permission model must be correct for every tool, or a misconfigured tool leaks access. |

---

## 6. Recommendation

**Remove MCP from the framework core (Option A).**

The decisive reason: **the architectural holes are in the SDK's registration model, not in our code.** The MCP SDK's `registerTool` callback does not accept a context parameter — it captures state via closure. This means actor threading requires building a per-request wrapper around the kernel, which is fighting the SDK's design. Every future SDK update risks breaking that wrapper. The framework's value proposition is headless commerce with a clean REST API; MCP is an integration concern that belongs at the consumer layer, not in the engine core.

Adopters who want MCP can build their own thin MCP server that calls the REST API (or `createCommerce()` / `LocalAPI`). This is the standard pattern: "headless commerce engine + your own AI agent layer." It eliminates the SDK dependency, the multi-tenant actor threading problem, and the per-tool permission model maintenance.

**Post-removal path for AI agent users:**
1. Keep `COMMERCE_AGENT_SYSTEM_PROMPT` as a general-purpose export (not MCP-specific).
2. Publish a companion package `@unifiedcommerce/mcp-server` that wraps the REST API in MCP, with proper per-request actor threading from day one — built on the SDK's latest API, not constrained by the kernel's boot-time registration model.
3. The companion package can iterate independently without coupling to the engine's release cycle.

**Migration for existing adopters:** The `MCPTool`, `MCPResource`, `toolBuilder`, and `getMCPActor` exports are removed. Adopters using `config.mcpTools` will get a compile-time error with a clear message pointing to `@unifiedcommerce/mcp-server`. The `ai_agent` role in config becomes inert (harmless to keep, easy to clean up).
