# RFC-041: MCP Tool Curation and Service-Layer Adapter

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-25
- **Prerequisite:** RFC-040 (MCP Protocol Compliance -- committed)
- **Scope:** `packages/core/src/interfaces/mcp/server.ts`, `packages/core/src/interfaces/rest/router.ts`, `packages/core/src/interfaces/mcp/tool-registry.ts` (new)
- **Motivation:** RFC-040 delivered 36 core MCP tools alongside 60+ REST routes. Both call `kernel.services.*`. The original RFC-041 proposed auto-generating MCP tools from REST routes to eliminate duplication. Research into production MCP systems reveals this is the wrong approach. FastMCP's creator warns that "LLMs achieve significantly better performance with well-designed and curated MCP servers than with auto-converted OpenAPI servers." Microsoft Research found tool performance degrades by up to 85% when tool count exceeds ~20. Shopify's production storefront MCP server exposes exactly 4 tools -- not the hundreds their GraphQL API has. The problem is not "how do we auto-generate 66 tools from 66 routes." The problem is "how do we curate 15-20 excellent tools from a service layer that has 100+ operations, without maintaining duplicated code."
- **Breaking changes:** MCP tool set reduces from 36 to ~18 curated tools. Tool names may change. No REST API changes.
- **Estimated effort:** 3-5 engineering-days
- **Database migrations:** None

---

## Table of Contents

1. [Why Auto-Generation Is Wrong](#1-why-auto-generation-is-wrong)
2. [The Architecture](#2-the-architecture)
3. [Tool Curation: The 18 Tools](#3-tool-curation-the-18-tools)
4. [Implementation](#4-implementation)
5. [Plugin Tool Budget](#5-plugin-tool-budget)
6. [What Gets Deleted](#6-what-gets-deleted)
7. [Definition of Done](#7-definition-of-done)

---

## 1. Why Auto-Generation Is Wrong

### 1.1 The Research

Three independent sources converge on the same conclusion:

**FastMCP (23K GitHub stars, most popular Python MCP framework):** "Generating MCP servers from OpenAPI is a great way to get started, but in practice LLMs achieve significantly better performance with well-designed and curated MCP servers than with auto-converted OpenAPI servers." Their recommendation: bootstrap to explore, then curate aggressively for production.

**Microsoft Research (September 2025, survey of 1,470 MCP servers):** Tool-space interference causes performance degradation up to 85% when tool count is high. At 107 tools, both large and small models failed completely. The practical ceiling for consistent accuracy is 5-7 tools without specialized filtering; 20 tools is the soft maximum for production systems.

**Shopify (5 production MCP servers):** Their storefront MCP -- the one used by real shoppers via AI agents -- has 4 tools. Not 4 per domain. 4 total. Their full Storefront API has dozens of GraphQL queries. They curated down to: search products, get store info, get cart, update cart.

**Anthropic (Building Effective Agents):** "Think about how much effort goes into human-computer interfaces (HCI), and plan to invest just as much effort in creating good agent-computer interfaces (ACI)." Tool design is not a code generation problem. It is a design problem.

### 1.2 What Goes Wrong with Auto-Generation

UC currently has 36 core tools + ~34 plugin tools = ~70 tools when all plugins are enabled. The original RFC-041 would have increased this to ~100 by auto-generating from all routes. The research predicts:

| Tool Count | Expected Behavior |
|------------|-------------------|
| 5-7 | Perfect accuracy |
| 10-15 | Excellent, minor selection errors |
| 20-30 | Degraded, frequent wrong tool selection |
| 50+ | Severely degraded, agents guess randomly |
| 100+ | Complete failure |

At ~70 tools, UC is already in the degradation zone. The correct response is not to auto-generate more tools. It is to curate fewer, better tools.

### 1.3 REST APIs and MCP Tools Serve Different Consumers

A REST API is designed for developers writing code. Atomic, composable, resource-centric endpoints let developers build any workflow by chaining calls cheaply (milliseconds per HTTP request, no LLM reasoning needed).

An MCP tool is designed for LLMs doing reasoning. Every tool call costs 500-2000ms of LLM inference, consumes thousands of tokens, and requires the model to decide which tool to use from a list. The economics are completely different:

| Concern | REST API | MCP Tool |
|---------|----------|----------|
| Consumer | Human developer | LLM agent |
| Call cost | ~5ms (HTTP) | ~1000ms (LLM reasoning) |
| Selection cost | Zero (developer picks) | High (model must choose from list) |
| Composability | Cheap (chain 10 calls = 50ms) | Expensive (chain 10 calls = 10 seconds + token cost) |
| Description purpose | Document HTTP contract | Guide model selection |
| Error format | HTTP status + JSON body | Actionable text the model can reason about |
| Response size | Minimal (JSON, no waste) | Concise (every token costs money) |

Auto-generating one tool per route ignores this difference. It gives the agent 66+ granular CRUD operations when what the agent needs is 15-20 workflow-oriented tools.

---

## 2. The Architecture

### 2.1 The Pattern: Payload CMS's Local API

The research found one system that achieves both zero duplication and good agent UX: Payload CMS. Their architecture:

```
REST/GraphQL Adapters (auto-generated from config)
       |
       v
   Local API  <--- payload.create(), payload.find(), payload.update()
       |
       v
   MCP Adapter (calls Local API directly, not HTTP)
```

UC already has this pattern. `kernel.services.*` IS the Local API:

```
REST Routes (routes/*.ts, manually wired to Hono)
       |
       v
   kernel.services.*  <--- catalog.create(), orders.list(), inventory.adjust()
       |
       v
   MCP Tools (server.ts, manually registered with SDK)
```

Both REST and MCP call the same service methods. The duplication is in the adapter glue, not the business logic. The question is whether the MCP adapter should mirror the REST routes 1:1 (current: 36 tools) or curate a smaller, agent-optimized surface.

### 2.2 The Decision: Curated Tools Calling Services Directly

MCP tools will:
1. Call `kernel.services.*` directly (in-process, no HTTP proxy)
2. Be hand-curated for agent workflows, not auto-generated from routes
3. Target ~18 core tools (down from 36)
4. Use agent-optimized descriptions (not REST API docs)
5. Apply enrichment (`_context`) to responses
6. Maintain Zod schemas for typed input validation

The router's `.mcpTools()` auto-generation (built in RFC-040) remains available for plugins that want zero-effort tool exposure. But core tools are curated, not generated.

### 2.3 Why Not Delete the Auto-Generation?

The `router().mcpTools()` capability built in RFC-040 is still valuable for:
- **Plugin rapid prototyping**: A new plugin gets basic MCP tools for free
- **Plugin developers who do not want to curate**: Simple plugins (CRUD-only) work fine with auto-generated tools
- **Development mode**: Auto-generate to explore, then curate for production

The auto-generation is an opt-in convenience, not the primary tool creation path.

---

## 3. Tool Curation: The 18 Tools

### 3.1 Design Principles

Following Anthropic's guidance and Shopify's example:

1. **Workflow-oriented, not resource-oriented.** Instead of `catalog_create_entity` + `catalog_publish` + `pricing_set_base_price` (3 tools, 3 calls), consider a compound tool that handles common workflows.
2. **Every tool earns its place.** If two tools are always used together, merge them. If a tool is rarely useful, remove it.
3. **Descriptions explain WHEN to use, not WHAT it does.** "Search products by name, category, or brand when the user asks about available items" is better than "Search the product catalog."
4. **Responses include next steps.** The `_context.relatedQueries` pattern is exactly right -- keep it.
5. **Read tools are cheap, write tools are expensive.** Expose more read operations than write operations. Writes need human confirmation in most commerce scenarios.

### 3.2 The Curated Core Tool Set

**Catalog (4 tools, down from 12):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `catalog_search` | `catalog_search` | Primary discovery tool. Unchanged. |
| `catalog_get` | `catalog_get_attributes` | Get entity with full attributes, variants, pricing, inventory in one call. Merges what required 2-3 calls. |
| `catalog_create` | `catalog_create_entity` | Create entity. Unchanged. |
| `catalog_manage` | `catalog_update`, `catalog_delete`, `catalog_publish`, `catalog_archive`, `catalog_discontinue`, `catalog_set_attributes`, `catalog_manage_category`, `catalog_manage_brand`, `catalog_manage_variant` | Single tool with `action` parameter. STRAP pattern: reduces 9 tools to 1. Actions: `update`, `delete`, `publish`, `archive`, `discontinue`, `set_attributes`, `assign_category`, `unassign_category`, `assign_brand`, `unassign_brand`, `create_variant`. |

**Inventory (2 tools, down from 5):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `inventory_check` | `inventory_check` | Check stock levels. Unchanged. |
| `inventory_adjust` | `inventory_adjust`, `inventory_reserve`, `inventory_release`, `inventory_manage_warehouse` | Single tool with `action` parameter: `adjust`, `reserve`, `release`. Warehouse management exposed only if explicitly requested. |

**Orders (2 tools, down from 4):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `order_get` | `order_get`, `order_fulfillments` | Get order with fulfillments included (single call, not two). |
| `order_list` | `order_list` | List orders. Unchanged. |

`order_change_status` is removed from the default tool set. Status changes are high-impact operations that should require explicit human approval. The tool can be re-enabled via configuration.

**Pricing (1 tool, down from 3):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `pricing_manage` | `pricing_set_base_price`, `pricing_list_prices`, `pricing_create_modifier` | Single tool with `action`: `set_price`, `list`, `create_modifier`. Pricing is a domain the agent rarely needs to call atomically. |

**Promotions (1 tool, down from 4):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `promotions_manage` | `promotions_create`, `promotions_list`, `promotions_validate`, `promotions_deactivate` | Single tool with `action`: `create`, `list`, `validate`, `deactivate`. |

**Cart (2 tools, unchanged):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `cart_create` | `cart_create` | Create cart. Unchanged. |
| `cart_add_item` | `cart_add_item` | Add item. Unchanged. |

**Analytics (2 tools, unchanged):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `analytics_query` | `analytics_query` | Query analytics. Unchanged. |
| `analytics_meta` | `analytics_meta` | Discover measures/dimensions. Unchanged. |

**Search (1 tool, down from 2):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `search` | `search_query`, `search_suggest` | Single tool with `mode`: `query` or `suggest`. Search is a single concept. |

**Webhooks (1 tool, unchanged):**

| Tool | Replaces | Rationale |
|------|----------|-----------|
| `webhooks_manage` | `webhooks_manage` | Already a compound STRAP-pattern tool. |

**Customers (0 tools, down from 1):**

`customers_get` is removed. Customer data queries go through `analytics_query` or are handled by customer-portal routes (which are session-authenticated, not agent-accessible).

**Total: 16 core tools** (down from 36). With enrichment, each tool returns more useful data per call.

### 3.3 Tool Description Quality

Every tool description follows Anthropic's guidance: explain WHEN to use it, not just WHAT it does.

```
// BAD (current):
"Search the product catalog. Supports filtering by entity type, publication status, category slug, brand slug, and free-text query."

// GOOD (curated):
"Find products in the catalog. Use when the user asks about available items, wants to browse by category or brand, or needs product details. Returns products with stock status, variant count, and pricing. Supports free-text search and filtering by type, status, category, or brand."
```

---

## 4. Implementation

### 4.1 The Tool Registry Pattern

Instead of registering tools inline in `server.ts`, create a registry that separates tool definition from tool registration.

File: `packages/core/src/interfaces/mcp/tool-registry.ts` (NEW)

```
PSEUDOCODE:

INTERFACE ToolDefinition:
  name: string
  description: string               -- agent-optimized, explains WHEN to use
  inputSchema: z.ZodType             -- Zod schema with .describe() on every field
  handler: (args, kernel) => result  -- receives validated args + kernel
  enrich?: (result, kernel) => enrichedResult  -- optional enrichment hook
  dangerous?: boolean                -- if true, tool is excluded from default set

FUNCTION defineTool(def: ToolDefinition): ToolDefinition
  -- Type-level helper, no runtime logic
  RETURN def

FUNCTION registerToolsOnServer(server: McpServer, kernel: Kernel, tools: ToolDefinition[]):
  FOR EACH tool IN tools:
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
    }, async (args) => {
      result = await tool.handler(args, kernel)
      if tool.enrich:
        result = await tool.enrich(result, kernel)
      RETURN { content: [{ type: "text", text: JSON.stringify(result) }] }
    })
```

### 4.2 Code Blueprint: Tool Definition

File: `packages/core/src/interfaces/mcp/tools/catalog.ts` (NEW)

```typescript
import { z } from "zod";
import type { Kernel } from "../../../runtime/kernel.js";
import { enrichEntityForAgent } from "../context-enrichment.js";

export const catalogSearch = defineTool({
  name: "catalog_search",
  description:
    "Find products in the catalog. Use when the user asks about available " +
    "items, wants to browse by category or brand, or needs product details. " +
    "Returns products with stock status, variant count, and pricing. " +
    "Supports free-text search and filtering by type, status, category, or brand.",
  inputSchema: z.object({
    query: z.string().optional().describe("Free-text search query"),
    type: z.string().optional().describe("Entity type (e.g., product, service)"),
    status: z.string().optional().describe("Status filter (draft, active, archived)"),
    categorySlug: z.string().optional().describe("Category slug"),
    brandSlug: z.string().optional().describe("Brand slug"),
    page: z.number().int().positive().default(1).describe("Page number"),
    limit: z.number().int().positive().max(100).default(20).describe("Results per page"),
  }),
  async handler({ query, type, status, categorySlug, brandSlug, page, limit }, kernel) {
    // ... same service calls as current server.ts ...
  },
  async enrich(result, kernel) {
    // Apply enrichEntityForAgent to each item
  },
});

export const catalogManage = defineTool({
  name: "catalog_manage",
  description:
    "Modify a catalog entity. Use for updates, publishing, archiving, " +
    "discontinuing, setting attributes, or managing category/brand assignments. " +
    "Specify the action and the entity ID. Returns the updated entity.",
  inputSchema: z.object({
    action: z.enum([
      "update", "delete", "publish", "archive", "discontinue",
      "set_attributes", "assign_category", "unassign_category",
      "assign_brand", "unassign_brand", "create_variant",
    ]).describe("The operation to perform"),
    entityId: z.string().describe("UUID of the entity"),
    // Conditional fields based on action:
    metadata: z.record(z.string(), z.unknown()).optional().describe("For update: metadata to merge"),
    locale: z.string().optional().describe("For set_attributes: locale code"),
    title: z.string().optional().describe("For set_attributes: new title"),
    description: z.string().optional().describe("For set_attributes: new description"),
    categoryId: z.string().optional().describe("For assign/unassign category"),
    brandId: z.string().optional().describe("For assign/unassign brand"),
    sku: z.string().optional().describe("For create_variant: SKU"),
  }),
  async handler(args, kernel) {
    switch (args.action) {
      case "update": return kernel.services.catalog.update(args.entityId, ...);
      case "publish": return kernel.services.catalog.publish(args.entityId, ...);
      // ... etc
    }
  },
  async enrich(result, kernel) {
    return enrichEntityForAgent(result, kernel);
  },
});
```

### 4.3 Tool Registration in Transport

File: `packages/core/src/interfaces/mcp/transport.ts` (modified)

```typescript
import { coreTools } from "./tools/index.js";

function buildMcpServer(kernel, customTools) {
  const server = new McpServer({ ... });

  // Register curated core tools
  registerToolsOnServer(server, kernel, coreTools);

  // Register core resources
  registerCoreResources(server, kernel);

  // Register plugin tools (legacy bridge)
  for (const tool of kernel.mcpTools) {
    registerLegacyTool(server, tool);
  }

  return server;
}
```

### 4.4 Configuration: Opt-In for Dangerous Tools

Some tools (like `order_change_status`) are excluded by default because they are high-impact. Enable them via config:

```typescript
// commerce.config.ts
export default defineConfig({
  mcp: {
    enableDangerousTools: ["order_change_status"],
  },
});
```

---

## 5. Plugin Tool Budget

### 5.1 The Problem

If each of the 6 priority plugins adds 5-7 tools, that is 30-42 plugin tools on top of 16 core tools = 46-58 total. This is above the degradation threshold.

### 5.2 The Solution: Plugin Tool Budgets

Each plugin should target 2-3 tools maximum, using the STRAP pattern (single tool with `action` parameter) to collapse CRUD operations.

| Plugin | Current Tools | Target | Pattern |
|--------|---------------|--------|---------|
| plugin-pos | 7 | 2 | `pos_shift` (open/close/report), `pos_transaction` (create/void/list) |
| plugin-appointments | 7 | 2 | `appointments_manage` (list/book/cancel/check_availability), `appointments_services` (list) |
| plugin-pos-restaurant | 6 | 2 | `restaurant_tables` (list/assign/transfer), `restaurant_kds` (list/transition) |
| plugin-gift-cards | 5 | 2 | `giftcards_manage` (issue/check_balance/list), `giftcards_transactions` (list) |
| plugin-loyalty | 5 | 2 | `loyalty_points` (balance/earn/redeem), `loyalty_offers` (list) |
| plugin-reviews | 4 | 2 | `reviews_manage` (list/submit/approve), `reviews_summary` (get) |
| **Total** | **34** | **12** | |

**With curation: 16 core + 12 plugin = 28 tools total.** This is at the upper boundary but manageable, especially since not all plugins are active simultaneously.

### 5.3 Dynamic Tool Scoping (Future)

As the tool count grows, implement dynamic tool discovery:
- Agent declares its intent ("I need to manage inventory")
- Server returns only relevant tools (inventory + analytics)
- Reduces per-request tool count to 5-10

This is the approach GitHub, Cursor, and VS Code MCP integrations are converging on. It is a future RFC, not this one.

---

## 6. What Gets Deleted

| File/Code | Lines | Action |
|-----------|-------|--------|
| 18 tool registrations in `server.ts` that collapse into STRAP-pattern tools | ~600 | Replaced by tool registry files |
| `router().mcpTools()` auto-generation | 0 | Kept (opt-in for plugins) |
| `router().noMcpTool()` | 0 | Kept (still useful for excluding routes) |
| Schema duplication between `server.ts` and `schemas/*.ts` | ~400 | Eliminated (tools define their own Zod schemas, no dependency on route schemas) |

**Net result:** `server.ts` shrinks from 1182 lines to ~100 lines (resource registration + wiring). Tool definitions move to `tools/*.ts` files (~500 lines total for 16 curated tools). Total MCP code: ~600 lines, down from ~1182.

---

## 7. Definition of Done

| Criterion | Verification |
|-----------|-------------|
| Core MCP tools reduced from 36 to ~16-18 | `tools/list` returns 16-18 core tools |
| Every tool has an agent-optimized description (explains WHEN to use, not just WHAT) | Manual review; each description is >= 30 words with usage guidance |
| STRAP-pattern tools (`catalog_manage`, `pricing_manage`, etc.) dispatch correctly for all actions | Integration test: each action in each compound tool |
| Enrichment (`_context`) applied to all entity/order/inventory responses | Test: `catalog_search` returns `_context.summary` and `relatedQueries` |
| Dangerous tools (`order_change_status`) excluded by default | Test: `tools/list` does not include it; enable via config -> appears |
| Plugin tools documented with target budget (2-3 per plugin) | Plugin README or inline docs |
| All existing REST tests pass unchanged | 32/32 test files pass |
| MCP protocol tests pass | `initialize`, `tools/list`, `tools/call` all succeed |
| Zero type errors | `tsc --noEmit` clean |
| Tool definition files organized by domain | `tools/catalog.ts`, `tools/inventory.ts`, `tools/orders.ts`, etc. |
| `server.ts` reduced to resource registration + wiring | < 100 lines, no `registerTool` calls |
