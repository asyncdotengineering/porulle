# RFC-040: MCP Protocol Compliance and Tool Coverage

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-25
- **Scope:** `packages/core/src/interfaces/mcp/`, `packages/core/src/config/types.ts`, `packages/core/src/runtime/kernel.ts`, `packages/core/src/runtime/server.ts`, `packages/core/package.json`, `packages/plugins/*/src/index.ts`
- **Motivation:** UC's MCP implementation is not spec-compliant. It does not use the official `@modelcontextprotocol/sdk`, does not speak JSON-RPC 2.0, does not implement the MCP lifecycle (`initialize`/`initialized`), and exposes a custom REST API that no MCP client -- including Claude Code, Claude Desktop, Cursor, or any SDK-based client -- can connect to. The 10 core tools and 10 plugin tools that exist are inaccessible to the outside world. Additionally, only 16% of REST operations have MCP tools (10 out of 60+), and 13 of 15 plugins export zero MCP tools. This RFC fixes the broken transport, adds the missing tools, and makes plugins provide tools. Nothing else. Agent identity, audit reasoning, approval workflows, and workflow orchestration are deferred to future RFCs -- they can be composed on top of a working MCP layer.
- **Breaking changes:** (1) The custom `MCPTool` interface in `config/types.ts` is replaced by `@modelcontextprotocol/sdk` types; plugin `mcpTools` signature changes from `(ctx) => MCPTool[]` to `(server, ctx) => void`. A legacy shim is provided for backward compat. (2) The MCP endpoint changes from `GET /mcp/sse` + `POST /mcp/tools/:name` to a single Streamable HTTP endpoint at `POST|GET|DELETE /mcp`. No database migrations. No `Actor` type changes. No new tables.
- **Prior art:** Payload CMS plugin-mcp (`@modelcontextprotocol/sdk@1.25.2` + `mcp-handler`, `McpServer.registerTool()` pattern), `mhart/mcp-hono-stateless` (Hono + `StreamableHTTPServerTransport`), `mattzcarey/hono-mcp-server` (Hono + `WebStandardStreamableHTTPServerTransport`), Shopify Storefront MCP (5 MCP servers using Streamable HTTP), Saleor MCP server (wraps GraphQL)
- **Estimated effort:** 10-14 engineering-days across 3 workstreams, parallelizable to 2 engineers over ~7 calendar days
- **Database migrations:** None. Zero new tables. Zero new columns.

---

## Table of Contents

0. [Non-Negotiable Engineering Principles](#0-non-negotiable-engineering-principles)
1. [Problem Statement](#1-problem-statement)
2. [Workstream 0: MCP Protocol Compliance](#2-workstream-0-mcp-protocol-compliance)
3. [Workstream 1: Complete MCP Tool Coverage](#3-workstream-1-complete-mcp-tool-coverage)
4. [Workstream 2: Mandatory Plugin MCP Convention](#4-workstream-2-mandatory-plugin-mcp-convention)
5. [Test Strategy](#5-test-strategy)
6. [Rollout Plan](#6-rollout-plan)
7. [Deferred Work](#7-deferred-work)

---

## 0. Non-Negotiable Engineering Principles

These rules apply to every line of code produced under this RFC. Violations are blocking review findings, not suggestions.

### 0.1 No `as any`, No `as unknown as T`, No Gratuitous Type Assertions

The codebase already has a `Record<string, unknown>` + `$dynamic()` + `getTableColumns()` pattern for handling dynamic types. Use it. Every `as any` is a lie to the compiler that will eventually become a runtime bug. The only acceptable assertion is narrowing via a type guard function that performs a runtime check:

```typescript
// FORBIDDEN -- silent lie, no runtime verification
const payload = ctx.context as { reasoning: string };

// FORBIDDEN -- double assertion to launder types
const db = something as unknown as DrizzleDatabase;

// REQUIRED -- runtime check then narrow
function isAgentApiKey(actor: Actor): boolean {
  return actor.type === "api_key" && actor.role === "ai_agent";
}

// REQUIRED -- safe extraction with typeof guard
const reasoning = typeof ctx.context?.["reasoning"] === "string"
  ? ctx.context["reasoning"]
  : null;
```

### 0.2 No Hardcoded Identities, No Magic Strings

The current `getMCPActor()` returns `userId: "mcp-agent"` with a hardcoded permission array. This is the exact anti-pattern this RFC eliminates. Every identity must flow from a registered record in the database, resolved at request time, never at module load time.

### 0.3 No Optional Chaining as Control Flow

```typescript
// FORBIDDEN -- hides logical errors behind undefined propagation
const orgId = actor?.organizationId ?? DEFAULT_ORG_ID;

// REQUIRED -- explicit null check, explicit error path
if (actor == null) {
  throw new CommerceForbiddenError("Authentication required.");
}
if (actor.organizationId == null) {
  throw new CommerceValidationError("Agent must be scoped to an organization.");
}
const orgId = actor.organizationId;
```

### 0.4 No Shortcuts in Schema Migrations

Every new column added to an existing table must be:
1. Nullable with a default on the initial migration (so existing rows are not broken).
2. Backfilled in a subsequent data migration script.
3. Made NOT NULL only after backfill is verified.

We do not use `notNull()` with `.default()` as a shortcut when the default would produce semantically incorrect data. An audit log entry that existed before agent reasoning was introduced should have `reasoning: null`, not `reasoning: ""`.

### 0.5 No Index-Free Queries on New Columns

Every column that participates in a WHERE clause, JOIN condition, or ORDER BY must have an index. No exceptions. The cost of a missing index on a 10M-row audit log table is a full sequential scan on every agent action query.

### 0.6 Drizzle `eq()` and `null` -- The Rule

Never pass `null` to Drizzle's `eq()`. It generates `column = NULL` which always evaluates to `UNKNOWN` in SQL, returning zero rows. Use `isNull(column)` for IS NULL checks. This was learned the hard way (see MEMORY.md -- null vs undefined for variantId).

```typescript
// FORBIDDEN -- generates "agent_id = NULL", returns 0 rows
eq(auditLog.agentId, null)

// REQUIRED -- generates "agent_id IS NULL", correct behavior
isNull(auditLog.agentId)
```

### 0.7 No Hand-Rolled Protocol Implementations

When an official SDK exists for a protocol, use it. Do not reimplement JSON-RPC framing, transport negotiation, session management, capability advertisement, or lifecycle handshakes by hand. The official `@modelcontextprotocol/sdk` handles all of this. The current `transport.ts` is 68 lines of custom code that does not speak JSON-RPC and cannot interoperate with any MCP client. This is the canonical example of what this principle prohibits.

```typescript
// FORBIDDEN -- hand-rolling protocol framing
router.post("/tools/:toolName", async (c) => {
  const tool = tools.find(t => t.name === c.req.param("toolName"));
  return c.json(await tool.handler(await c.req.json()));
});

// REQUIRED -- delegate protocol handling to the official SDK
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const server = new McpServer({ name: "unified-commerce", version: "0.1.0" });
server.registerTool("catalog_search", { inputSchema: z.object({...}) }, handler);
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);
return transport.handleRequest(request);
```

### 0.8 Use Zod for MCP Input Schemas, Not Hand-Written JSON Schema

The official MCP SDK requires Zod v4 schemas for `inputSchema` in `registerTool()`. It converts these to JSON Schema for client consumption automatically. Do not hand-write JSON Schema objects. Zod schemas provide compile-time type safety for handler arguments, automatic validation before the handler runs (the SDK validates inputs), and a single source of truth for both TypeScript types and the wire schema.

```typescript
// FORBIDDEN -- hand-written JSON Schema, untyped handler
{
  inputSchema: {
    type: "object",
    properties: {
      entityId: { type: "string" },
      quantity: { type: "number" },
    },
    required: ["entityId", "quantity"],
  },
  handler: async (params: unknown) => {
    const input = asObject(params);
    const entityId = readString(input, "entityId");  // manual extraction
  }
}

// REQUIRED -- Zod schema, destructured typed handler
server.registerTool("inventory_adjust", {
  inputSchema: z.object({
    entityId: z.string().uuid().describe("UUID of the entity"),
    quantity: z.number().int().describe("Adjustment amount (positive adds, negative removes)"),
    reason: z.string().describe("Reason for the adjustment"),
  }),
}, async ({ entityId, quantity, reason }) => {
  // entityId is typed as string, quantity as number -- no manual extraction
});
```

---

## 1. Problem Statement

### 1.1 The Competitive Landscape Has Moved

When VISION-AGENTIC.md was written (2026-03-18), it stated: "Nobody is building this. Shopify has Sidekick (a thin chat assistant). Medusa has no AI story. Saleor has no AI story."

Six days later, the gap analysis reveals this is no longer true:

| Platform | MCP Tools | Agent Identity | Agent Protocol | Open Source |
|----------|-----------|----------------|----------------|-------------|
| **Shopify** | 5 MCP servers (Storefront, Catalog, Checkout, Dev, Extensions) | Per-store via shop domain | UCP (co-created with Google) | No |
| **Saleor** | 1 MCP server (wraps GraphQL) | Via ACP token propagation | ACP (OpenAI/Stripe) | Yes (Python) |
| **commercetools** | Commerce MCP + Developer MCP (Early Access) | Agent Gateway (enterprise) | Stripe ACS | No |
| **Medusa** | Docs MCP (official) + community operational MCP | None | None | Yes (TypeScript) |
| **UC** | 10 core + 10 plugin tools (NOT spec-compliant -- custom REST, not JSON-RPC) | Hardcoded single actor | None | Yes (TypeScript) |

UC's actual competitive differentiator remains real: no open-source TypeScript commerce platform ships native MCP tools covering the full commerce domain as part of its published core package. But that differentiator is currently theoretical, not functional. The tools exist in the codebase but are unreachable by any MCP client because the transport layer does not implement the MCP specification.

### 1.2 The Three Gaps This RFC Fixes

**Gap 0: MCP Protocol Non-Compliance (CRITICAL).** UC's `packages/core/src/interfaces/mcp/transport.ts` is a 68-line hand-rolled Hono router that exposes `GET /mcp/sse` + `POST /mcp/tools/:toolName` + `GET /mcp/resources` + `GET /mcp/resources/:resourceId`. This is a custom REST API, not an MCP implementation. The MCP specification (2025-03-26) requires JSON-RPC 2.0 message framing, a lifecycle handshake (`initialize` / `notifications/initialized`), capability negotiation, and a Streamable HTTP transport (single endpoint, POST for messages, GET for SSE stream, DELETE for session teardown). UC implements none of this. It does not depend on `@modelcontextprotocol/sdk`. When Claude Code connects to `http://localhost:4001/mcp/sse`, it sends an `initialize` JSON-RPC request. UC has no handler for it. The connection fails. Every tool is invisible. Payload CMS -- in this same repository at `about-payloadcms/payload/packages/plugin-mcp/` -- uses the official SDK correctly. UC is the only platform claiming MCP support that does not.

**Gap 1: MCP Tool Coverage (16% of REST operations).** 50+ REST operations have no MCP tool equivalent. An agent cannot update a product, set a price, create a promotion, manage webhooks, or transition an order via MCP. Agents that operate commerce businesses need write access, not just read.

**Gap 2: Plugin MCP Convention (unenforced).** 13 of 15 plugins export zero MCP tools despite having complex REST APIs. The `mcpTools` field in `defineCommercePlugin` is optional and undocumented. POS alone has 7 route files with zero agent accessibility.

### 1.3 What This RFC Does NOT Address

Everything below is deferred to future RFCs (see Section 7). None of it is needed for Claude Code to connect and use UC's commerce tools:

- **Agent identity** (dedicated actor type, agent registry, scoped permissions) -- Better Auth API keys work today.
- **Audit reasoning** (agent explanations persisted in audit log) -- single-column migration, future RFC.
- **Approval workflows** (pending actions, human-in-the-loop) -- no production agents exist yet.
- **Workflow orchestration** (DAG engine, multi-agent coordination) -- single-agent sequential tool calls suffice.
- **ACP/UCP protocol support** -- separate protocol compliance RFC.
- **Agent marketplace** -- requires all of the above first.

---

## 2. Workstream 0: MCP Protocol Compliance

This workstream is a hard prerequisite for all others. Until the MCP transport is spec-compliant, no MCP client can connect, and no tool -- existing or new -- is reachable. This workstream rewrites the transport layer, migrates tool registration to the official SDK, and eliminates the custom `MCPTool` interface.

### 2.0.1 Current Implementation (What Is Wrong)

File: `packages/core/src/interfaces/mcp/transport.ts` (68 lines)

The current implementation is a custom Hono router with four hand-rolled endpoints:

```typescript
// CURRENT -- custom REST, NOT MCP
router.get("/sse", async (c) =>             // emits "event: ready" with tool names (non-standard)
  streamSSE(c, async (stream) => {
    await handleMCPSession(stream, capabilities);
  }),
);
router.post("/tools/:toolName", async (c) => {  // raw JSON body, not JSON-RPC
  const tool = capabilities.tools.find((item) => item.name === c.req.param("toolName"));
  if (!tool) return c.json({ error: "Tool not found" }, 404);
  return c.json(await tool.handler(await c.req.json<unknown>()));
});
router.get("/resources", async (c) => { ... });        // list resources (non-standard)
router.get("/resources/:resourceId", async (c) => { ... }); // read resource (non-standard)
```

**14 spec violations** identified (9 critical):

| # | Violation | Severity |
|---|-----------|----------|
| 1 | No `@modelcontextprotocol/sdk` dependency | Critical |
| 2 | No JSON-RPC 2.0 message framing (`jsonrpc: "2.0"`, `method`, `id`) | Critical |
| 3 | No `initialize` / `notifications/initialized` lifecycle handshake | Critical |
| 4 | No `tools/list` JSON-RPC method (uses custom SSE event instead) | Critical |
| 5 | No `tools/call` JSON-RPC method (uses `POST /tools/:name` instead) | Critical |
| 6 | No `resources/list` or `resources/read` JSON-RPC methods | Critical |
| 7 | No `ping` support | Medium |
| 8 | Custom `GET /mcp/sse` with `event: ready` instead of any spec transport | Critical |
| 9 | Custom `POST /mcp/tools/:toolName` instead of JSON-RPC dispatch | Critical |
| 10 | No `Mcp-Session-Id` header handling | Medium |
| 11 | No capability negotiation (server does not declare tools/resources/prompts support) | Critical |
| 12 | Hand-written JSON Schema instead of Zod | Low |
| 13 | Untyped handler signature `(params: unknown) => Promise<unknown>` | Low |
| 14 | Custom `MCPTool` interface instead of SDK types | Low |

The custom `MCPTool` interface in `packages/core/src/config/types.ts:166-171`:

```typescript
export interface MCPTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;  // hand-written JSON Schema
  handler: (params: unknown) => Promise<unknown>;  // untyped
}
```

This interface is used by the plugin system (`defineCommercePlugin({ mcpTools })`) and all 10 core tools. It must be replaced.

### 2.0.2 Target State

UC's MCP layer uses the official `@modelcontextprotocol/sdk` with `McpServer` for tool/resource registration and `WebStandardStreamableHTTPServerTransport` for HTTP handling. A single endpoint at `/mcp` handles POST (JSON-RPC messages), GET (SSE stream), and DELETE (session teardown). All tools use Zod v4 schemas for input validation. The handler signature is typed: arguments are destructured from the validated Zod schema.

Clients connect via:
```json
{
  "mcpServers": {
    "unified-commerce": {
      "type": "http",
      "url": "http://localhost:4001/mcp"
    }
  }
}
```

### 2.0.3 Architecture Decision: Stateless vs Stateful

**Decision: Stateless (new server + transport per request).**

Rationale: UC runs on Bun, deploys to Vercel (serverless), and has no guarantee of long-lived process memory. Stateless mode (`sessionIdGenerator: undefined`) creates a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport` per incoming request, handles the JSON-RPC message, and tears down. This matches the pattern used by `mhart/mcp-hono-stateless` (deployed to Cloudflare Workers) and the official SDK's Express example for stateless mode.

The cost is that each request re-registers tools. With 36+ tools, this adds ~1-2ms of registration overhead per request. This is negligible compared to the database queries in tool handlers (10-100ms). If profiling later shows this is a bottleneck, we can cache the `McpServer` instance in a module-level variable with a TTL. But premature optimization here would add session management complexity that conflicts with serverless deployment.

### 2.0.4 Pseudocode: New Transport Layer

```
FUNCTION createMCPHandler(kernel):
  router = new Hono()

  FUNCTION buildMcpServer():
    server = new McpServer({
      name: "unified-commerce",
      version: kernel.config.version ?? "0.1.0"
    }, {
      capabilities: { tools: {}, resources: {}, logging: {} }
    })

    -- Register all core tools using Zod schemas
    FOR EACH tool definition in CORE_TOOL_DEFINITIONS:
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.zodSchema,
      }, tool.handler(kernel))

    -- Register plugin tools
    -- Plugins now provide a function that receives the McpServer directly
    -- and calls server.registerTool() themselves
    FOR EACH pluginRegistrar in kernel.mcpToolRegistrars:
      pluginRegistrar(server, kernel)

    -- Register core resources
    FOR EACH resource in CORE_RESOURCES:
      server.registerResource(resource.name, resource.uri, {
        description: resource.description,
        mimeType: resource.mimeType,
      }, resource.handler(kernel))

    -- Register plugin resources
    FOR EACH pluginResourceRegistrar in kernel.mcpResourceRegistrars:
      pluginResourceRegistrar(server, kernel)

    RETURN server

  FUNCTION handleRequest(request):
    server = buildMcpServer()
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined  -- stateless
    })
    await server.connect(transport)

    TRY:
      response = await transport.handleRequest(request)
      RETURN response
    FINALLY:
      transport.close()
      server.close()

  -- Single endpoint, three HTTP methods per Streamable HTTP spec
  router.post("/", async (c) => handleRequest(c.req.raw))
  router.get("/", async (c) => handleRequest(c.req.raw))
  router.delete("/", async (c) => {
    -- Stateless: no session to terminate
    RETURN new Response(null, { status: 405 })
  })

  RETURN router
```

### 2.0.5 Code Blueprint: New Transport Layer

File: `packages/core/src/interfaces/mcp/transport.ts` (REWRITTEN -- replaces 68-line custom implementation)

```typescript
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Kernel } from "../../runtime/kernel.js";
import { registerCoreTools } from "./tools.js";
import { registerCoreResources } from "./resources.js";

/**
 * Creates a spec-compliant MCP handler mounted as a Hono sub-router.
 *
 * Implements the Streamable HTTP transport (MCP spec 2025-03-26):
 *   POST /  -- receives JSON-RPC 2.0 messages (initialize, tools/call, etc.)
 *   GET /   -- opens SSE stream for server-initiated messages
 *   DELETE / -- session teardown (405 in stateless mode)
 *
 * Stateless: a new McpServer + transport is created per request.
 * This is correct for serverless (Vercel, CF Workers) and long-lived (Bun) runtimes.
 */
export function createMCPHandler(kernel: Kernel): Hono {
  const router = new Hono();

  function buildMcpServer(): McpServer {
    const server = new McpServer(
      {
        name: kernel.config.storeName ?? "unified-commerce",
        version: kernel.config.version ?? "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          logging: {},
        },
      },
    );

    // Register core tools (Zod-validated, typed handlers)
    registerCoreTools(server, kernel);

    // Register plugin tools
    // Plugins provide registrar functions: (server: McpServer, kernel: Kernel) => void
    for (const registrar of kernel.mcpToolRegistrars) {
      registrar(server, kernel);
    }

    // Register core resources
    registerCoreResources(server, kernel);

    // Register plugin resources
    for (const registrar of kernel.mcpResourceRegistrars) {
      registrar(server, kernel);
    }

    return server;
  }

  async function handleRequest(request: Request): Promise<Response> {
    const server = buildMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless -- no session tracking
    });

    await server.connect(transport);

    try {
      return await transport.handleRequest(request);
    } finally {
      transport.close();
      server.close();
    }
  }

  // Streamable HTTP: single endpoint, three methods
  router.post("/", async (c) => handleRequest(c.req.raw));
  router.get("/", async (c) => handleRequest(c.req.raw));
  router.delete("/", () =>
    new Response(null, { status: 405, statusText: "Method Not Allowed" }),
  );

  return router;
}
```

### 2.0.6 Code Blueprint: Core Tool Registration (Migrated to SDK)

File: `packages/core/src/interfaces/mcp/tools.ts` (NEW -- extracted from server.ts, migrated to SDK pattern)

This file replaces the monolithic `registerMCPCapabilities()` function. Each tool is registered via `server.registerTool()` with a Zod schema and a typed, destructured handler.

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Kernel } from "../../runtime/kernel.js";
import {
  enrichEntityForAgent,
  enrichInventoryForAgent,
  enrichOrderForAgent,
} from "./context-enrichment.js";

/**
 * Registers all core commerce MCP tools on the given McpServer instance.
 *
 * Each tool uses Zod for input validation (SDK validates before handler runs),
 * destructured typed arguments (no manual param extraction), and returns
 * the standard MCP result format: { content: [{ type: "text", text: "..." }] }.
 */
export function registerCoreTools(server: McpServer, kernel: Kernel): void {

  // --- Catalog Tools ---

  server.registerTool(
    "catalog_search",
    {
      description:
        "Search the product catalog. Supports filtering by entity type, " +
        "publication status, category slug, brand slug, and free-text query. " +
        "Returns paginated results enriched with stock status and variant counts.",
      inputSchema: z.object({
        query: z.string().optional().describe("Free-text search query"),
        type: z.string().optional().describe("Entity type filter (e.g., 'product', 'service')"),
        status: z.string().optional().describe("Status filter (draft, active, archived, discontinued)"),
        categorySlug: z.string().optional().describe("Category slug to filter by"),
        brandSlug: z.string().optional().describe("Brand slug to filter by"),
        page: z.number().int().positive().default(1).describe("Page number (1-indexed)"),
        limit: z.number().int().positive().max(100).default(20).describe("Results per page (max 100)"),
      }),
    },
    async ({ query, type, status, categorySlug, brandSlug, page, limit }) => {
      const trimmed = (query ?? "").trim().toLowerCase();

      if (trimmed.length > 0) {
        const searchResult = await kernel.services.search.query({
          query: trimmed,
          page,
          limit,
          filters: {
            ...(type != null ? { type } : {}),
            ...(status != null ? { status } : {}),
            ...(categorySlug != null ? { category: categorySlug } : {}),
            ...(brandSlug != null ? { brand: brandSlug } : {}),
          },
        });

        if (!searchResult.ok) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: searchResult.error }) }],
            isError: true,
          };
        }

        const enrichedItems = await Promise.all(
          searchResult.value.hits.map(async (hit) => {
            const entityResult = await kernel.services.catalog.getById(hit.id);
            if (entityResult.ok) {
              return enrichEntityForAgent(entityResult.value, kernel);
            }
            return hit.document;
          }),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              items: enrichedItems,
              pagination: {
                page: searchResult.value.page,
                limit: searchResult.value.limit,
                total: searchResult.value.total,
                totalPages: Math.max(1, Math.ceil(searchResult.value.total / searchResult.value.limit)),
              },
              facets: searchResult.value.facets,
            }, null, 2),
          }],
        };
      }

      // No query: list with filters
      const result = await kernel.services.catalog.list({
        filter: {
          ...(type != null ? { type } : {}),
          ...(status != null ? { status } : {}),
          ...(categorySlug != null ? { category: categorySlug } : {}),
          ...(brandSlug != null ? { brand: brandSlug } : {}),
        },
        pagination: { page, limit },
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      const enrichedItems = await Promise.all(
        result.value.items.map((item) => enrichEntityForAgent(item, kernel)),
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...result.value, items: enrichedItems }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    "catalog_create_entity",
    {
      description:
        "Create a new catalog entity (product, service, etc.) in draft status. " +
        "Requires type, slug, and title. Returns the created entity.",
      inputSchema: z.object({
        type: z.string().describe("Entity type (must match a configured entity type)"),
        slug: z.string().describe("URL-friendly unique identifier"),
        title: z.string().describe("Display title"),
        description: z.string().optional().describe("Entity description"),
        metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata key-value pairs"),
        reasoning: z.string().optional().describe("Agent reasoning for this action (persisted in audit log)"),
      }),
    },
    async ({ type, slug, title, description, metadata, reasoning }) => {
      const actor = kernel.getMCPActor();
      const result = await kernel.services.catalog.create(
        { type, slug, title, description, metadata },
        { actor, requestId: crypto.randomUUID(), origin: "mcp" as const, reasoning },
      );

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      const enriched = await enrichEntityForAgent(result.value, kernel);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }],
      };
    },
  );

  // --- Inventory Tools ---

  server.registerTool(
    "inventory_check",
    {
      description:
        "Check available inventory for one or more entities. " +
        "Returns quantity on hand, reserved, available, and reorder thresholds.",
      inputSchema: z.object({
        entityIds: z.array(z.string()).min(1).describe("Array of entity UUIDs to check"),
      }),
    },
    async ({ entityIds }) => {
      const results = await Promise.all(
        entityIds.map(async (entityId) => {
          const result = await kernel.services.inventory.getAvailableQuantity(entityId);
          if (!result.ok) return { entityId, error: result.error };
          return enrichInventoryForAgent({ entityId, ...result.value });
        }),
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.registerTool(
    "inventory_adjust",
    {
      description:
        "Adjust inventory quantity for an entity. Positive values add stock, " +
        "negative values remove stock. A reason is required for the audit trail.",
      inputSchema: z.object({
        entityId: z.string().describe("UUID of the entity"),
        adjustment: z.number().int().describe("Quantity to adjust (positive = add, negative = remove)"),
        reason: z.string().describe("Human-readable reason for the adjustment"),
        variantId: z.string().optional().describe("Variant UUID if adjusting variant-level inventory"),
        reasoning: z.string().optional().describe("Agent reasoning for this action (persisted in audit log)"),
      }),
    },
    async ({ entityId, adjustment, reason, variantId, reasoning }) => {
      const actor = kernel.getMCPActor();
      const result = await kernel.services.inventory.adjust(
        {
          entityId,
          variantId: variantId ?? null,
          adjustment,
          reason,
        },
        { actor, requestId: crypto.randomUUID(), origin: "mcp" as const, reasoning },
      );

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  // --- Cart & Order Tools ---
  // (Same pattern: z.object for inputSchema, typed destructuring, enrichment on return)
  // Remaining tools: cart_create, cart_add_item, order_get, order_list,
  //                  analytics_query, analytics_meta
  // Each follows the identical pattern shown above.
  // Full implementations omitted for brevity -- see Workstream 1 for the complete tool list.
}
```

### 2.0.7 Code Blueprint: Core Resource Registration

File: `packages/core/src/interfaces/mcp/resources.ts` (NEW -- extracted from server.ts)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Kernel } from "../../runtime/kernel.js";
import { orderStateMachine } from "../../kernel/state-machine/machine.js";

export function registerCoreResources(server: McpServer, kernel: Kernel): void {
  server.registerResource(
    "Entity Type Schema",
    "commerce://schema/entity-types",
    {
      description: "Complete entity type schema including fields, variants, and fulfillment strategies.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [{
        uri: "commerce://schema/entity-types",
        text: JSON.stringify(kernel.config.entities ?? {}, null, 2),
        mimeType: "application/json",
      }],
    }),
  );

  server.registerResource(
    "Order State Machine",
    "commerce://schema/order-states",
    {
      description: "Valid order status transitions and the complete state machine definition.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [{
        uri: "commerce://schema/order-states",
        text: JSON.stringify(orderStateMachine, null, 2),
        mimeType: "application/json",
      }],
    }),
  );
}
```

### 2.0.8 Plugin System Migration: From `MCPTool[]` to Registrar Functions

The current plugin manifest returns `MCPTool[]` -- an array of custom tool objects. The new pattern passes the `McpServer` instance to the plugin, which calls `server.registerTool()` directly.

#### 2.0.8.1 Pseudocode

```
-- OLD PLUGIN PATTERN (custom MCPTool interface)
defineCommercePlugin({
  mcpTools: (ctx: PluginContext) => MCPTool[]
  -- returns array of { name, description, inputSchema, handler }
})

-- NEW PLUGIN PATTERN (SDK-native registration)
defineCommercePlugin({
  mcpTools: (server: McpServer, ctx: PluginContext) => void
  -- receives McpServer instance, calls server.registerTool() directly
  -- no intermediate array; tools are registered in-place
})
```

#### 2.0.8.2 Code Blueprint: Updated Plugin Manifest

File: `packages/core/src/kernel/plugin/manifest.ts` (modified)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface CommercePluginManifest {
  id: string;
  version: string;
  requires?: string[];
  permissions?: PluginPermission[];
  schema?: () => Record<string, unknown>;
  hooks?: () => PluginHookRegistration[];
  routes?: (ctx: PluginContext) => PluginRouteRegistration[];
  /**
   * Register MCP tools on the McpServer instance.
   *
   * REQUIRED. Every plugin must register its agent-accessible operations.
   * If the plugin has no agent-accessible operations, provide a no-op:
   *
   *   mcpTools: () => {},  // No agent operations: UoM is data-only
   *
   * Use server.registerTool() with Zod schemas:
   *
   *   mcpTools: (server, ctx) => {
   *     server.registerTool("myplugin_operation", {
   *       inputSchema: z.object({ ... }),
   *     }, async (args) => ({ content: [{ type: "text", text: "..." }] }));
   *   },
   */
  mcpTools: (server: McpServer, ctx: PluginContext) => void;
  analyticsModels?: () => unknown[];
}
```

#### 2.0.8.3 Code Blueprint: Migrated Marketplace Plugin Example

File: `packages/plugins/plugin-marketplace/src/mcp-tools.ts` (modified)

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMarketplaceMCPTools(
  server: McpServer,
  services: MarketplaceServices,
  _options: MarketplacePluginOptions,
): void {

  server.registerTool(
    "marketplace_vendor_list",
    {
      description: "List marketplace vendors with optional status, tier, and search filters.",
      inputSchema: z.object({
        status: z.string().optional().describe("Filter by vendor status"),
        tier: z.string().optional().describe("Filter by vendor tier"),
        search: z.string().optional().describe("Search vendors by name"),
      }),
    },
    async ({ status, tier, search }) => {
      const rows = await services.vendor.list({ status, tier, search });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  server.registerTool(
    "marketplace_vendor_performance",
    {
      description: "Get vendor performance metrics including rating, tier, and performance score.",
      inputSchema: z.object({
        vendorId: z.string().describe("UUID of the vendor"),
      }),
    },
    async ({ vendorId }) => {
      const perf = await services.vendor.getPerformance(vendorId);
      if (perf == null) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Vendor not found." }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(perf, null, 2) }],
      };
    },
  );

  // ... remaining marketplace tools follow same pattern ...
}
```

### 2.0.9 Kernel Changes

File: `packages/core/src/runtime/kernel.ts` (modified)

The kernel must store plugin registrar functions instead of pre-evaluated `MCPTool[]` arrays:

```typescript
// OLD
mcpTools: MCPTool[];
mcpResources: MCPResource[];

// NEW
mcpToolRegistrars: Array<(server: McpServer, kernel: Kernel) => void>;
mcpResourceRegistrars: Array<(server: McpServer, kernel: Kernel) => void>;
```

The `defineCommercePlugin()` function collects these registrars during config transformation. The `createMCPHandler()` function invokes them at request time when building the `McpServer`.

### 2.0.10 Server.ts Route Change

File: `packages/core/src/runtime/server.ts` (modified)

```typescript
// OLD (line 254)
app.route("/mcp", createMCPHandler(kernel, config.mcpTools));

// NEW -- single Streamable HTTP endpoint
app.route("/mcp", createMCPHandler(kernel));
```

Clients connect to `POST|GET http://host:port/mcp` (not `/mcp/sse`).

### 2.0.11 Dependencies

Add to `packages/core/package.json`:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1"
  },
  "peerDependencies": {
    "zod": "^3.25.0"
  }
}
```

Zod is already a dependency of the SDK. UC already uses Zod for REST route validation (via `@hono/zod-openapi`). No new dependency graph conflict.

### 2.0.12 Backward Compatibility: The `config.mcpTools` Legacy Path

Some UC applications may define custom tools via `config.mcpTools: (kernel) => MCPTool[]` using the old interface. During the transition, a shim wraps old-style tools into `server.registerTool()` calls:

```typescript
// In transport.ts, after registering core and plugin tools:
if (kernel.config.mcpTools != null) {
  const legacyTools = kernel.config.mcpTools(kernel);
  for (const tool of legacyTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // Legacy tools use hand-written JSON Schema; pass through as-is
        // The SDK accepts raw JSON Schema objects in addition to Zod
        inputSchema: tool.inputSchema ?? {},
      },
      async (args: Record<string, unknown>) => {
        const result = await tool.handler(args);
        // Normalize to MCP result format
        if (result != null && typeof result === "object" && "content" in result) {
          return result as { content: Array<{ type: "text"; text: string }> };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }
}
```

This shim is temporary. It will be removed in the next major version after all consumers migrate to the new registrar pattern.

### 2.0.13 Definition of Done -- Workstream 0

| Criterion | Verification Method |
|-----------|-------------------|
| `@modelcontextprotocol/sdk` is a dependency in `packages/core/package.json` | `grep "@modelcontextprotocol/sdk" packages/core/package.json` |
| `transport.ts` is rewritten to use `McpServer` + `WebStandardStreamableHTTPServerTransport` | Code review; no hand-rolled JSON-RPC parsing or custom route handlers |
| Old `transport.ts` (68 lines, 4 custom routes) is fully replaced | `git diff` shows complete rewrite; no `router.post("/tools/:toolName")` pattern |
| MCP endpoint is `POST\|GET\|DELETE /mcp` (single path, three methods) | Integration test: `POST /mcp` with `initialize` JSON-RPC returns valid response |
| `initialize` handshake works: client sends `initialize` request, server responds with `protocolVersion`, `capabilities`, `serverInfo` | Integration test using `@modelcontextprotocol/sdk` client: `const client = new Client(...)` -> `await client.connect(transport)` succeeds |
| `tools/list` returns all registered tools with name, description, inputSchema | Integration test: `await client.listTools()` returns 10+ tools |
| `tools/call` invokes a tool and returns `{ content: [...] }` | Integration test: `await client.callTool({ name: "catalog_search", arguments: {} })` returns results |
| `resources/list` returns all registered resources | Integration test: `await client.listResources()` returns 2 resources |
| `resources/read` returns resource content | Integration test: `await client.readResource({ uri: "commerce://schema/entity-types" })` returns JSON |
| `ping` responds with `{ result: {} }` | Integration test: manual JSON-RPC ping message returns valid response |
| All 10 existing core tools migrated from custom `MCPTool` to `server.registerTool()` with Zod schemas | Grep for `server.registerTool` in `tools.ts`; count >= 10. Grep for `MCPTool` in `server.ts`; count == 0 |
| All 10 existing plugin tools (marketplace 8 + cubejs 2) migrated to new registrar pattern | `plugin-marketplace/src/mcp-tools.ts` uses `server.registerTool()`. `plugin-cubejs/src/index.ts` uses `server.registerTool()`. |
| Custom `MCPTool` interface in `config/types.ts` marked as `@deprecated` with migration docs | JSDoc `@deprecated` annotation present |
| Legacy `config.mcpTools` shim works for backward compat | Integration test: old-style `config.mcpTools` function still registers tools |
| Claude Code can connect: add UC to `.mcp.json` with `type: "http"`, tools are discovered and callable | Manual verification: `claude mcp add unified-commerce --transport http http://localhost:4001/mcp` -> `/mcp` shows tools |
| No `as any` in any new or modified file | `grep -rn "as any" packages/core/src/interfaces/mcp/` returns zero matches |
| No hand-written JSON Schema in new tool registrations (all use Zod) | Code review; all `inputSchema` values are `z.object(...)` calls |
| The old `readString`/`readNumber`/`asObject`/`validationError` helper functions are removed | Grep for these function names in `mcp/` directory returns zero |
| Existing REST API tests pass (MCP rewrite does not break REST) | Full test suite passes |

---

## 3. Workstream 1: Complete MCP Tool Coverage

### 3.1 Current State

`packages/core/src/interfaces/mcp/server.ts` exports `registerMCPCapabilities(kernel)` which returns 10 tools and 2 resources. The tools cover 5 domains:

| Domain | Tools | Operations Covered |
|--------|-------|--------------------|
| Catalog | `catalog_search`, `catalog_create_entity` | search, create |
| Inventory | `inventory_check`, `inventory_adjust` | read, adjust |
| Cart | `cart_create`, `cart_add_item` | create, addItem |
| Orders | `order_get`, `order_list` | read, list |
| Analytics | `analytics_query`, `analytics_meta` | query, meta |

Operations **not** covered by MCP tools (50+):
- Catalog: update, delete, publish, archive, discontinue, setAttributes, getAttributes, category CRUD, brand CRUD, variant CRUD, option CRUD
- Inventory: reserve, release, createWarehouse, listWarehouses
- Orders: changeStatus, getFulfillments
- Pricing: setBasePrice, listPrices, createModifier (all three operations)
- Promotions: create, list, validate, deactivate (all four operations)
- Search: query, suggest (both operations)
- Webhooks: create, list, delete (all three operations)
- Media: upload, get, delete (all three operations)
- Customers: list, get, update, groups (admin operations)

### 3.2 Target State

Every REST operation that exists in `packages/core/src/interfaces/rest/routes/` must have a corresponding MCP tool. The tool name follows the convention `{domain}_{operation}` in snake_case. The tool must accept the same parameters as the REST route's Zod schema and return the same response shape, enriched with `_context` where applicable.

### 3.3 Tool Inventory (Full List of New Tools)

The following pseudocode describes the complete set of new tools. After Workstream 0, all tools use `server.registerTool()` with Zod schemas and typed destructured handlers. The old `asObject`/`readString`/`readNumber` helpers are deleted. Each tool is registered in `packages/core/src/interfaces/mcp/tools.ts` via `registerCoreTools(server, kernel)`, service method invoked via `kernel.services.*`, result returned as `{ content: [{ type: "text", text: JSON.stringify(value) }] }` or `{ content: [...], isError: true }`.

#### 2.3.1 Catalog Mutation Tools

```
TOOL catalog_update_entity
  INPUT: entityId (string, required), updates (object: title?, description?, metadata?, isVisible?)
  PSEUDOCODE:
    validate entityId is non-empty string
    resolve MCP actor from request context
    call kernel.services.catalog.update(entityId, updates, { actor })
    if error, return { error }
    enrich result with enrichEntityForAgent
    return textContent(enrichedEntity)

TOOL catalog_delete_entity
  INPUT: entityId (string, required)
  PSEUDOCODE:
    validate entityId
    resolve MCP actor
    call kernel.services.catalog.delete(entityId, { actor })
    if error, return { error }
    return textContent({ deleted: true, entityId })

TOOL catalog_publish
  INPUT: entityId (string, required)
  PSEUDOCODE:
    validate entityId
    resolve MCP actor
    call kernel.services.catalog.publish(entityId, { actor })
    if error, return { error }
    enrich and return

TOOL catalog_archive
  INPUT: entityId (string, required)
  PSEUDOCODE:
    validate entityId
    resolve MCP actor
    call kernel.services.catalog.archive(entityId, { actor })
    if error, return { error }
    return textContent(result)

TOOL catalog_discontinue
  INPUT: entityId (string, required)
  PSEUDOCODE:
    validate entityId
    resolve MCP actor
    call kernel.services.catalog.discontinue(entityId, { actor })
    if error, return { error }
    return textContent(result)

TOOL catalog_set_attributes
  INPUT: entityId (string, required), locale (string, required), attributes (object: title, subtitle?, description?, richDescription?, seoTitle?, seoDescription?)
  PSEUDOCODE:
    validate entityId and locale
    resolve MCP actor
    call kernel.services.catalog.setAttributes(entityId, locale, attributes, { actor })
    return result or error

TOOL catalog_get_attributes
  INPUT: entityId (string, required), locale (string, required)
  PSEUDOCODE:
    validate entityId and locale
    call kernel.services.catalog.getAttributes(entityId, locale)
    return textContent(attributes)

TOOL catalog_manage_category
  INPUT: action (string: "create" | "update" | "delete" | "assign" | "unassign"), categoryId? (string), entityId? (string), slug? (string), parentId? (string), metadata? (object)
  PSEUDOCODE:
    switch on action:
      "create": call kernel.services.catalog.createCategory({ slug, parentId, metadata })
      "update": call kernel.services.catalog.updateCategory(categoryId, { slug, metadata })
      "delete": call kernel.services.catalog.deleteCategory(categoryId)
      "assign": call kernel.services.catalog.addCategory(entityId, categoryId)
      "unassign": call kernel.services.catalog.removeCategory(entityId, categoryId)
    return result or error

TOOL catalog_manage_brand
  INPUT: action (string: "create" | "update" | "delete" | "assign" | "unassign"), brandId? (string), entityId? (string), slug? (string), displayName? (string), metadata? (object)
  PSEUDOCODE:
    switch on action:
      "create": call kernel.services.catalog.createBrand({ slug, displayName, metadata })
      "update": call kernel.services.catalog.updateBrand(brandId, { slug, displayName, metadata })
      "delete": call kernel.services.catalog.deleteBrand(brandId)
      "assign": call kernel.services.catalog.addBrand(entityId, brandId)
      "unassign": call kernel.services.catalog.removeBrand(entityId, brandId)
    return result or error

TOOL catalog_manage_variant
  INPUT: entityId (string, required), action (string: "create" | "generate"), sku? (string), barcode? (string), optionValues? (array of { optionTypeId, optionValueId })
  PSEUDOCODE:
    if action == "create":
      call kernel.services.catalog.createVariant(entityId, { sku, barcode, optionValues })
    if action == "generate":
      call kernel.services.catalog.generateVariants(entityId)
    return result or error
```

#### 2.3.2 Inventory Transaction Tools

```
TOOL inventory_reserve
  INPUT: entityId (string, required), quantity (number, required), variantId? (string), referenceType? (string), referenceId? (string)
  PSEUDOCODE:
    validate entityId and quantity > 0
    resolve MCP actor
    call kernel.services.inventory.reserve({
      entityId, variantId: variantId ?? null, quantity, referenceType, referenceId
    }, { actor })
    if error, return { error }
    return textContent(result)

TOOL inventory_release
  INPUT: entityId (string, required), quantity (number, required), variantId? (string), referenceType? (string), referenceId? (string)
  PSEUDOCODE:
    validate entityId and quantity > 0
    resolve MCP actor
    call kernel.services.inventory.release({
      entityId, variantId: variantId ?? null, quantity, referenceType, referenceId
    }, { actor })
    if error, return { error }
    return textContent(result)

TOOL inventory_manage_warehouse
  INPUT: action (string: "create" | "list"), name? (string), code? (string), address? (object), isActive? (boolean), priority? (number)
  PSEUDOCODE:
    if action == "create":
      call kernel.services.inventory.createWarehouse({ name, code, address, isActive, priority })
    if action == "list":
      call kernel.services.inventory.listWarehouses()
    return result or error
```

#### 2.3.3 Order Management Tools

```
TOOL order_change_status
  INPUT: orderId (string, required), status (string, required), reason? (string)
  PSEUDOCODE:
    validate orderId and status is valid transition target
    resolve MCP actor
    call kernel.services.orders.changeStatus(orderId, status, reason, { actor })
    if error (invalid transition), return descriptive error with valid transitions
    enrich with enrichOrderForAgent
    return textContent(enrichedOrder)

TOOL order_fulfillments
  INPUT: orderId (string, required)
  PSEUDOCODE:
    validate orderId
    call kernel.services.orders.listFulfillments(orderId)
    return textContent(fulfillments)
```

#### 2.3.4 Pricing Tools

```
TOOL pricing_set_base_price
  INPUT: entityId (string, required), currency (string, required), amount (number, required), variantId? (string), customerGroupId? (string), minQuantity? (number), maxQuantity? (number), validFrom? (string ISO date), validUntil? (string ISO date)
  PSEUDOCODE:
    validate entityId, currency (3-char ISO), amount >= 0
    resolve MCP actor
    coerce validFrom/validUntil from ISO strings to Date objects (see RFC promotions fix)
    call kernel.services.pricing.setBasePrice({
      entityId, variantId: variantId ?? null, currency, amount,
      customerGroupId, minQuantity, maxQuantity, validFrom, validUntil
    }, { actor })
    return result or error

TOOL pricing_list_prices
  INPUT: entityId? (string), variantId? (string), currency? (string), page? (number), limit? (number)
  PSEUDOCODE:
    call kernel.services.pricing.listPrices({ entityId, variantId, currency }, { page, limit })
    return textContent(prices)

TOOL pricing_create_modifier
  INPUT: name (string, required), type (string: "percentage_discount" | "fixed_discount" | "markup" | "override", required), value (number, required), priority? (number), entityId? (string), variantId? (string), customerGroupId? (string), currency? (string), conditions? (object), validFrom? (string), validUntil? (string)
  PSEUDOCODE:
    validate name, type is one of enum values, value is finite number
    resolve MCP actor
    coerce date strings to Date objects
    call kernel.services.pricing.createModifier({ ... }, { actor })
    return result or error
```

#### 2.3.5 Promotion Tools

```
TOOL promotions_create
  INPUT: name (string, required), type (string, required), value (number, required), code? (string), isAutomatic? (boolean), priority? (number), conditions? (object), usageLimitTotal? (number), usageLimitPerCustomer? (number), validFrom? (string), validUntil? (string), buyQuantity? (number), getQuantity? (number)
  PSEUDOCODE:
    validate name, type is valid promotion type, value is finite
    resolve MCP actor
    coerce validFrom/validUntil from ISO strings to Date objects
    call kernel.services.promotions.create({ ... }, { actor })
    return result or error

TOOL promotions_list
  INPUT: page? (number), limit? (number), isActive? (boolean)
  PSEUDOCODE:
    call kernel.services.promotions.list({ page, limit, isActive })
    return textContent(promotions)

TOOL promotions_validate
  INPUT: promotionId (string, required), cartId? (string), customerId? (string)
  PSEUDOCODE:
    call kernel.services.promotions.validate(promotionId, { cartId, customerId })
    return textContent(validationResult)

TOOL promotions_deactivate
  INPUT: promotionId (string, required)
  PSEUDOCODE:
    resolve MCP actor
    call kernel.services.promotions.deactivate(promotionId, { actor })
    return result or error
```

#### 2.3.6 Search, Webhooks, Media, Customer Tools

```
TOOL search_query
  INPUT: query (string, required), page? (number), limit? (number), filters? (object)
  PSEUDOCODE:
    call kernel.services.search.query({ query, page, limit, filters })
    return textContent(searchResults)

TOOL search_suggest
  INPUT: query (string, required), limit? (number)
  PSEUDOCODE:
    call kernel.services.search.suggest({ query, limit })
    return textContent(suggestions)

TOOL webhooks_manage
  INPUT: action (string: "create" | "list" | "delete"), url? (string), events? (string[]), endpointId? (string)
  PSEUDOCODE:
    resolve MCP actor
    switch on action:
      "create": validate url and events, call kernel.services.webhooks.createEndpoint({ url, events })
      "list": call kernel.services.webhooks.listEndpoints()
      "delete": validate endpointId, call kernel.services.webhooks.deleteEndpoint(endpointId)
    return result or error

TOOL customers_list
  INPUT: page? (number), limit? (number), search? (string), groupId? (string)
  PSEUDOCODE:
    resolve MCP actor, assert permission "customers:read"
    call kernel.services.customers.list({ page, limit, search, groupId })
    return textContent(customers)

TOOL customers_get
  INPUT: customerId (string, required)
  PSEUDOCODE:
    resolve MCP actor, assert permission "customers:read"
    call kernel.services.customers.getById(customerId)
    return textContent(customer) or error
```

### 3.4 Code Blueprint: Tool Registration Pattern (Post-Workstream 0)

After Workstream 0, all tools use `server.registerTool()` with Zod schemas. The following is the canonical reference implementation for `catalog_update_entity`. Every subsequent tool follows this exact structure.

File: `packages/core/src/interfaces/mcp/tools.ts`

```typescript
server.registerTool(
  "catalog_update_entity",
  {
    description:
      "Update an existing catalog entity. Supports partial updates to title, " +
      "description, metadata, and visibility. Entity must exist and be in a " +
      "mutable status (draft or active). Returns the updated entity with enriched context.",
    inputSchema: z.object({
      entityId: z.string().uuid().describe("UUID of the entity to update"),
      title: z.string().optional().describe("New title for the entity"),
      description: z.string().optional().describe("New description for the entity"),
      metadata: z.record(z.unknown()).optional().describe("Arbitrary key-value metadata to merge"),
      isVisible: z.boolean().optional().describe("Whether the entity is visible in storefront"),
      reasoning: z.string().optional().describe(
        "Agent's explanation for why this update is being made. " +
        "Persisted in the audit log for human review.",
      ),
    }).refine(
      (data) =>
        data.title !== undefined ||
        data.description !== undefined ||
        data.metadata !== undefined ||
        data.isVisible !== undefined,
      {
        message: "At least one field to update must be provided (title, description, metadata, isVisible).",
      },
    ),
  },
  async ({ entityId, title, description, metadata, isVisible, reasoning }) => {
    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates["title"] = title;
    if (description !== undefined) updates["description"] = description;
    if (metadata !== undefined) updates["metadata"] = metadata;
    if (isVisible !== undefined) updates["isVisible"] = isVisible;

    const actor = kernel.getMCPActor();
    const result = await kernel.services.catalog.update(entityId, updates, {
      actor,
      requestId: crypto.randomUUID(),
      origin: "mcp" as const,
      reasoning,
    });

    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
        isError: true,
      };
    }

    const enriched = await enrichEntityForAgent(result.value, kernel);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }],
    };
  },
);
```

**Critical implementation notes:**

1. **Zod `.refine()` replaces manual validation.** The "at least one update field" check is a Zod refinement. The SDK runs validation before the handler, so the handler body never receives invalid input. No `if (!entityId)` checks -- Zod rejects missing required fields automatically.
2. **Typed destructured arguments.** `entityId` is `string`, `title` is `string | undefined`, `isVisible` is `boolean | undefined`. No `readString(input, "title")` extraction. The compiler enforces correct usage.
3. **The `reasoning` parameter** flows through `HookContext.context.reasoning` into the audit log. When the audit reasoning column is added (deferred -- see Section 7), this field will be persisted automatically.
4. **`origin: "mcp"`** on the hook context is already supported by the `HookOrigin` type. This allows hooks to distinguish agent-initiated mutations from human-initiated ones.
5. **Error results use `isError: true`** per the MCP spec, instead of a custom `{ error: {...} }` shape. This tells the client that the tool executed but encountered a domain error (distinct from a protocol error).

### 3.5 Definition of Done -- Workstream 1

| Criterion | Verification Method |
|-----------|-------------------|
| All 26 new MCP tools registered in `registerMCPCapabilities()` | Grep for tool names in server.ts; count must be 36 total (10 existing + 26 new) |
| Every tool has a non-empty `description` field that explains what it does, when to use it, and what it returns | Manual review; descriptions must be >= 20 words |
| Every tool has a complete `inputSchema` with `type`, `description` on each property, and a correct `required` array | JSON Schema validation of each inputSchema |
| Every tool that performs a write operation accepts an optional `reasoning: string` parameter | Grep for `reasoning` in every tool with write semantics |
| Every tool that returns an entity uses the appropriate `enrichXForAgent()` function | Grep for `enrichEntityForAgent`, `enrichOrderForAgent`, `enrichInventoryForAgent` in handler bodies |
| Every tool validates required inputs before calling service methods; validation errors use `validationError()` helper, never thrown exceptions | Code review; no `throw` in handler bodies |
| Every tool passes `origin: "mcp"` in the hook context | Grep for `origin: "mcp"` in every handler that calls a service method |
| No tool uses `as any` or `as unknown as T` | `grep -r "as any\|as unknown as" packages/core/src/interfaces/mcp/server.ts` returns zero matches |
| Integration test for each new tool that verifies: (a) successful execution with valid input, (b) validation error with missing required input, (c) correct enrichment on return value | Test file `packages/core/test/mcp-tools-complete.test.ts` with >= 78 test cases (3 per tool x 26 tools) |
| `COMMERCE_AGENT_SYSTEM_PROMPT` in `agent-prompt.ts` updated to document all 26 new tools | Manual review; each tool listed with description in the prompt |
| `COMMERCE_AGENT_SYSTEM_PROMPT_COMPACT` also updated | Manual review |

---

## 4. Workstream 2: Mandatory Plugin MCP Convention

### 4.1 Current State

`defineCommercePlugin` in `packages/core/src/kernel/plugin/manifest.ts` accepts `mcpTools` as an optional field. 13 of 15 plugins do not provide it. There is no build-time or runtime enforcement, no documentation of the convention, and no tooling to scaffold MCP tools for a plugin.

### 4.2 Target State

1. `mcpTools` becomes a required field in `CommercePluginManifest` (type-level enforcement).
2. Plugins that genuinely have no agent-accessible operations provide a no-op registrar (`mcpTools: () => {}`) with a comment explaining why.
3. After Workstream 0, plugins use the `server.registerTool()` SDK API directly.
4. The 6 most impactful plugins (POS, appointments, restaurant, gift-cards, loyalty, reviews) ship MCP tools.

### 4.3 Manifest Change

#### 4.3.1 Pseudocode

```
INTERFACE CommercePluginManifest:
  id: string (required)
  version: string (required)
  requires?: string[]
  permissions?: PluginPermission[]
  schema?: () => Record<string, unknown>
  hooks?: () => PluginHookRegistration[]
  routes?: (ctx: PluginContext) => PluginRouteRegistration[]
  mcpTools: (server: McpServer, ctx: PluginContext) => void  // CHANGED: was optional MCPTool[], now required registrar
  analyticsModels?: () => unknown[]
```

#### 4.3.2 Code Blueprint

File: `packages/core/src/kernel/plugin/manifest.ts` (modified)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface CommercePluginManifest {
  id: string;
  version: string;
  requires?: string[];
  permissions?: PluginPermission[];
  schema?: () => Record<string, unknown>;
  hooks?: () => PluginHookRegistration[];
  routes?: (ctx: PluginContext) => PluginRouteRegistration[];
  /**
   * Register MCP tools on the McpServer instance.
   *
   * REQUIRED. Every plugin must register its agent-accessible operations.
   * If the plugin has no agent-accessible operations, provide a no-op:
   *
   *   mcpTools: () => [],  // No agent-accessible operations: UoM is a data-only plugin
   *
   * Tools should cover the plugin's primary operations: list, get, create,
   * update, delete. Use the naming convention: `{pluginId}_{operation}`.
   */
  mcpTools: (ctx: PluginContext) => MCPTool[];
  analyticsModels?: () => unknown[];
}
```

### 6.4 Plugin MCP Tool Helper

File: `packages/core/src/interfaces/mcp/plugin-tool-builder.ts`

```typescript
import type { MCPTool } from "../../config/types.js";

interface PluginToolOptions<TInput extends Record<string, unknown>> {
  pluginId: string;
  operation: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: TInput) => Promise<unknown>;
}

/**
 * Standardized MCP tool builder for plugins.
 *
 * Enforces naming convention ({pluginId}_{operation}),
 * applies input validation, and wraps the handler with
 * standard error formatting.
 */
export function buildPluginMCPTool<
  TInput extends Record<string, unknown>,
>(options: PluginToolOptions<TInput>): MCPTool {
  const name = `${options.pluginId}_${options.operation}`;

  return {
    name,
    description: options.description,
    inputSchema: options.inputSchema,
    handler: async (params: unknown) => {
      const input =
        params != null && typeof params === "object" && !Array.isArray(params)
          ? (params as TInput)
          : ({} as TInput);

      try {
        const result = await options.handler(input);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          error: {
            code: "PLUGIN_TOOL_ERROR",
            message: `[${name}] ${message}`,
          },
        };
      }
    },
  };
}
```

### 6.5 Priority Plugin MCP Tools

The following 6 plugins are prioritized for MCP tool addition based on strategic value (vertical SaaS builder use cases):

**plugin-pos (7 tools):**
- `pos_open_shift` -- open a shift for a terminal
- `pos_close_shift` -- close shift with cash count
- `pos_create_transaction` -- ring up a POS transaction
- `pos_void_transaction` -- void an incomplete transaction
- `pos_accept_payment` -- accept payment on a transaction
- `pos_process_return` -- process a return
- `pos_lookup_product` -- search product for POS display

**plugin-appointments (5 tools):**
- `appointments_list_services` -- list bookable services
- `appointments_check_availability` -- check provider availability
- `appointments_create_booking` -- create a booking
- `appointments_cancel_booking` -- cancel a booking
- `appointments_list_bookings` -- list bookings with filters

**plugin-pos-restaurant (5 tools):**
- `restaurant_list_tables` -- list tables with status
- `restaurant_assign_table` -- assign a party to a table
- `restaurant_kds_tickets` -- list KDS tickets
- `restaurant_kds_transition` -- transition a KDS ticket status
- `restaurant_86_item` -- mark an item as 86'd (unavailable)

**plugin-gift-cards (3 tools):**
- `giftcards_issue` -- issue a new gift card
- `giftcards_check_balance` -- check gift card balance
- `giftcards_redeem` -- redeem gift card against an order

**plugin-loyalty (3 tools):**
- `loyalty_get_balance` -- get customer loyalty point balance
- `loyalty_earn_points` -- manually award points
- `loyalty_redeem_points` -- redeem points

**plugin-reviews (3 tools):**
- `reviews_list` -- list reviews for an entity
- `reviews_moderate` -- approve or reject a review
- `reviews_get_summary` -- get aggregate rating summary

### 4.6 Definition of Done -- Workstream 2

| Criterion | Verification Method |
|-----------|-------------------|
| `mcpTools` is required (not optional) in `CommercePluginManifest` | TypeScript compilation fails if mcpTools is omitted from any `defineCommercePlugin` call |
| All 15 plugins provide a `mcpTools` function (empty array where appropriate) | Grep for `mcpTools:` in all 15 plugin index.ts files returns 15 matches |
| Plugins use `server.registerTool()` with Zod schemas (not the old `MCPTool` interface) | Grep for `server.registerTool` in all 6 priority plugins |
| plugin-pos exports 7 MCP tools | Count tools returned by plugin's mcpTools function |
| plugin-appointments exports 5 MCP tools | Count tools returned |
| plugin-pos-restaurant exports 5 MCP tools | Count tools returned |
| plugin-gift-cards exports 3 MCP tools | Count tools returned |
| plugin-loyalty exports 3 MCP tools | Count tools returned |
| plugin-reviews exports 3 MCP tools | Count tools returned |
| Each plugin MCP tool follows the naming convention `{pluginId}_{operation}` | Grep for tool names; all match pattern |
| Each plugin MCP tool has a non-empty description (>= 15 words) | Automated check in test |
| Integration test for each plugin's MCP tools (at minimum: one success, one validation error per tool) | Test files: `packages/plugins/*/test/mcp-tools.test.ts` |
| `COMMERCE_AGENT_SYSTEM_PROMPT` updated to mention plugin tools as extensible | Agent prompt includes paragraph about plugin tools |
| No `as any` in any plugin MCP tool code | Grep across all plugins |

---

## 5. Test Strategy

### 5.1 Protocol Compliance (Workstream 0)

| Test File | Covers |
|-----------|--------|
| `packages/core/test/mcp-protocol-compliance.test.ts` | Uses `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` to connect to UC. Tests: (1) `initialize` handshake. (2) `tools/list` returns all tools. (3) `tools/call` executes a tool. (4) `tools/call` with bad args returns `isError: true`. (5) `resources/list` and `resources/read`. (6) `ping`. (7) Plugin tools appear in listing. (8) Legacy `config.mcpTools` shim works. |

### 5.2 Tool Coverage (Workstream 1)

| Test File | Covers |
|-----------|--------|
| `packages/core/test/mcp-tools-complete.test.ts` | All 36 MCP tools (10 existing + 26 new): success path, validation error path, enrichment on return. Uses SDK client, not curl. |

### 5.3 Plugin Tools (Workstream 2)

| Test File | Covers |
|-----------|--------|
| `packages/plugins/plugin-pos/test/mcp-tools.test.ts` | POS MCP tools (7) |
| `packages/plugins/plugin-appointments/test/mcp-tools.test.ts` | Appointment MCP tools (5) |
| `packages/plugins/plugin-pos-restaurant/test/mcp-tools.test.ts` | Restaurant MCP tools (5) |
| `packages/plugins/plugin-gift-cards/test/mcp-tools.test.ts` | Gift card MCP tools (3) |
| `packages/plugins/plugin-loyalty/test/mcp-tools.test.ts` | Loyalty MCP tools (3) |
| `packages/plugins/plugin-reviews/test/mcp-tools.test.ts` | Reviews MCP tools (3) |

---

## 6. Rollout Plan

### Phase 0: Fix the Transport (Days 1-4)

1. Day 1: Install `@modelcontextprotocol/sdk`. Rewrite `transport.ts` with `McpServer` + `WebStandardStreamableHTTPServerTransport`. Update route mount in `server.ts`. Verify `initialize` handshake with curl.
2. Day 2: Migrate all 10 core tools from `MCPTool[]` to `server.registerTool()` with Zod schemas. Migrate 2 resources to `server.registerResource()`. Delete old helper functions (`readString`, `readNumber`, `asObject`, `textContent`, `validationError`).
3. Day 3: Update kernel (`mcpToolRegistrars` replaces `mcpTools`). Update `defineCommercePlugin` signature. Migrate marketplace (8 tools) and cubejs (2 tools) plugins. Add legacy shim for `config.mcpTools`.
4. Day 4: Protocol compliance integration tests. Verify Claude Code connectivity.

**Gate:** Claude Code connects and discovers all 10+ tools. SDK client tests pass. All existing REST tests pass.

### Phase 1: Add Missing Tools (Days 5-8)

1. Day 5-6: Implement 26 new core MCP tools using `server.registerTool()` with Zod schemas.
2. Day 7: Integration tests for all 36 tools.
3. Day 8: Update `COMMERCE_AGENT_SYSTEM_PROMPT` and `COMMERCE_AGENT_SYSTEM_PROMPT_COMPACT` to document all tools.

**Gate:** 36 tools discoverable via `tools/list`. All integration tests pass.

### Phase 2: Plugin Tools (Days 9-12)

1. Day 9: Make `mcpTools` required in manifest. Fix all 15 plugins to provide registrar function.
2. Day 10: POS (7 tools) + appointments (5 tools).
3. Day 11: Restaurant (5 tools) + gift-cards (3 tools) + loyalty (3 tools) + reviews (3 tools).
4. Day 12: Plugin integration tests. End-to-end Claude Code validation with plugin tools.

**Gate:** 62+ tools total (36 core + 26 plugin). All discoverable and callable from Claude Code.

---

## 7. Deferred Work

The following items are explicitly out of scope for this RFC. They can be composed on top of a working MCP layer in future RFCs.

| Item | Why Deferred | Prerequisite |
|------|-------------|--------------|
| **Agent Identity** (dedicated actor type, agent registry) | Better Auth API keys with `role: "ai_agent"` already work. A separate actor type is only needed when agents require capabilities API keys cannot provide (sub-agent delegation, mutable state). | This RFC (working MCP) |
| **Audit Reasoning** (`reasoning` column on audit log) | Useful but not required for MCP tools to function. Can be added as a single-column migration in a follow-up. | This RFC |
| **Approval Workflows** (pending actions, policy evaluation) | No production agents exist yet. Build the approval layer when the first agent runs unsupervised and the merchant requests guardrails. | Agent Identity RFC |
| **Workflow Orchestration** (DAG engine, multi-agent coordination) | No user has requested multi-agent workflows. Single-agent sequential tool calls (within one MCP session) cover all current use cases. | Approval Workflows RFC |
| **ACP/UCP Protocol Support** | Requires external protocol compliance (Stripe/OpenAI ACP, Google/Shopify UCP). Separate RFC with its own spec analysis. | This RFC |
| **Agent Marketplace** (packaging, registry, CLI install) | Requires agent identity, workflows, and a mature plugin ecosystem. Layer 5 concern. | All of the above |

