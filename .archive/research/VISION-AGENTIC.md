# Agentic Commerce Infrastructure

**Date:** 2026-03-18
**Companion to:** VISION.md
**Question:** How does UnifiedCommerce become the agentic commerce infrastructure for vertical SaaS builders?

---

## The Insight

Commerce is the most AI-automatable business domain that exists:

1. **Structured data** -- products, prices, orders, customers are well-defined entities with clear schemas. No ambiguity. Perfect for agents.
2. **Repetitive operations** -- updating 1,000 product descriptions, adjusting prices across seasons, sending personalized emails, processing returns. Tedious for humans, trivial for agents.
3. **Data-rich decision-making** -- sales data, customer behavior, inventory levels, pricing history. Agents can optimize what humans cannot process.
4. **Time-sensitive reactions** -- flash sales, stock-outs, competitive pricing, abandoned cart recovery. Agents react in milliseconds.

If UC is the infrastructure for vertical SaaS, and AI agents are the operators of those vertical SaaS businesses, then UC needs to be the best platform for AI agents to operate commerce businesses.

Nobody is building this. Shopify has Sidekick (a thin chat assistant). Medusa has no AI story. Saleor has no AI story. commercetools has no AI story. The entire commerce industry treats AI as a feature. UC can treat AI as the architecture.

---

## What "Agentic" Means Concretely

An agentic commerce platform has five layers:

```
Layer 5: Agent Marketplace (pre-built agents you install)
Layer 4: Agent Workflows (multi-agent orchestration)
Layer 3: Agent Actions (audit, reasoning, human-in-the-loop)
Layer 2: Agent Identity (auth, permissions, scoping)
Layer 1: Agent-Ready APIs (structured, typed, discoverable)
```

### Layer 1: Agent-Ready APIs (UC already has this)

This is the foundation. UC is already ahead of every competitor here:

| Capability | Status | What We Have |
|-----------|--------|-------------|
| OpenAPI spec | Done | 129+ typed paths at `GET /api/doc` |
| MCP tools | Done | 10 core tools (catalog_search, cart_create, order_get, analytics_query, etc.) |
| Plugin MCP tools | Done | Marketplace plugin adds 8 more tools via `mcpTools` manifest |
| Typed SDK | Done | `createSDK()` with domain namespaces, TypeScript types |
| Semantic analytics layer | Done | `COMMERCE_AGENT_SYSTEM_PROMPT` grounds agents in metric definitions |
| Context enrichment | Done | `enrichEntityForAgent()`, `enrichOrderForAgent()` format data for LLM consumption |

This layer is about making every operation in the engine callable by an AI agent with zero ambiguity. UC has this. Most competitors do not.

### Layer 2: Agent Identity and Permissions

This is the first gap. Today, an AI agent authenticates as either:
- A dev API key (`x-api-key: dev-staff-key`) with wildcard permissions
- A human user's session (the agent pretends to be the human)

Neither is correct. An AI agent is its own actor type with its own identity, its own permission scope, and its own audit trail.

**What needs to be built:**

```
Agent Identity:
  - Agents are first-class actors (type: "agent", not "user" or "api_key")
  - Each agent has: name, description, owner (user or org), permission scope
  - Agents authenticate via scoped API keys tied to agent records
  - Agent sessions carry the agent's identity through every operation
  - The Actor type gains: agentId, agentName alongside userId

Agent Permissions:
  - Fine-grained: "this agent can update prices but cannot delete products"
  - Resource-scoped: "this agent can only operate on entities in category X"
  - Value-bounded: "this agent can adjust prices by at most 20%"
  - Time-bounded: "this agent is active during business hours only"
  - Approval-gated: "this agent can draft price changes, human approves"

Agent Registry:
  - POST /api/agents              -- create an agent with name + permissions
  - GET  /api/agents              -- list registered agents
  - POST /api/agents/{id}/keys    -- generate API key scoped to this agent
  - GET  /api/agents/{id}/actions -- view agent's action history
```

**Why this matters for vertical SaaS builders:**
A restaurant platform built on UC can offer their merchants: "Install the Menu Optimization Agent -- it analyzes your sales data and suggests menu price adjustments." The agent runs with scoped permissions under the merchant's organization. The merchant sees what the agent did and can approve or revert.

### Layer 3: Agent Actions (Audit, Reasoning, Human-in-the-Loop)

Every action an AI agent takes must be:
1. **Logged** with full context (what, when, why, who authorized)
2. **Explainable** (the agent's reasoning is stored alongside the action)
3. **Reversible** (agent actions can be reverted by a human)
4. **Approvable** (high-impact actions require human confirmation)

**What needs to be built:**

```
Agent Action Log:
  - Extends commerce_audit_log with agent-specific fields:
    - agent_id (which agent performed this)
    - reasoning (the agent's explanation for why it took this action)
    - confidence (0-1 score, if the agent provides one)
    - approval_status (auto_approved, pending_approval, approved, rejected)
    - parent_action_id (for multi-step workflows)

Human-in-the-Loop:
  - Agent actions can be gated by approval policies:
    - "Price changes > 10% require human approval"
    - "Product deletions always require approval"
    - "Inventory adjustments > 100 units require approval"
  - Approval policies are configurable per agent, per org
  - Pending actions are queued, humans approve/reject via API or admin UI
  - Approved actions execute; rejected actions are logged but not executed

Action Policies (JSON config):
  {
    "agent_id": "pricing-agent-001",
    "rules": [
      {
        "resource": "pricing",
        "action": "update",
        "condition": "delta_percentage > 10",
        "require": "human_approval"
      },
      {
        "resource": "catalog",
        "action": "delete",
        "require": "human_approval"
      },
      {
        "resource": "inventory",
        "action": "adjust",
        "condition": "abs(quantity) > 100",
        "require": "human_approval"
      }
    ]
  }
```

**Why this matters:**
Trust is the bottleneck for AI adoption in commerce. A merchant will not let an AI agent change prices unsupervised. But they WILL let it run if they can see exactly what it did, why it did it, and approve high-impact changes. The audit + approval layer makes AI agents trustworthy enough for production commerce.

### Layer 4: Agent Workflows (Multi-Agent Orchestration)

Single agents are useful. Multiple agents collaborating are transformative.

**Example: End-of-Season Clearance Workflow**
```
1. Inventory Agent identifies slow-moving products (quantity_on_hand > 50, last_sold > 30 days)
2. Pricing Agent calculates markdown strategy (20% off first week, 40% off second week)
3. Catalog Agent updates product descriptions ("SALE: Was EUR 1,500, Now EUR 1,200")
4. Marketing Agent drafts email campaign for loyalty customers
5. Analytics Agent monitors sell-through rate and adjusts strategy daily

All five agents coordinate via a shared workflow context.
Human approves the overall strategy; individual actions execute automatically.
```

**What needs to be built:**

```
Workflow Engine:
  - Workflows are DAGs (directed acyclic graphs) of agent actions
  - Each node is: agent_id + tool_name + parameters + dependencies
  - Workflows can be triggered by: schedule, event, human, or another agent
  - Workflow state is persisted (survives server restarts)
  - Built on the existing job queue (commerce_jobs table)

Workflow Definition (declarative):
  {
    "name": "end-of-season-clearance",
    "trigger": { "type": "schedule", "cron": "0 9 * * 1" },
    "steps": [
      {
        "id": "identify-slow-movers",
        "agent": "inventory-agent",
        "tool": "analytics_query",
        "params": { "measures": ["Inventory.totalOnHand"], "filters": [...] },
        "output": "slow_moving_products"
      },
      {
        "id": "calculate-markdowns",
        "agent": "pricing-agent",
        "tool": "pricing_bulk_update",
        "params": { "products": "${slow_moving_products}", "strategy": "progressive" },
        "depends_on": ["identify-slow-movers"],
        "require_approval": true
      }
    ]
  }

Inter-Agent Communication:
  - Agents share context via a workflow-scoped key-value store
  - Agent A writes: { "slow_movers": [...ids] }
  - Agent B reads: workflow.context.slow_movers
  - No direct agent-to-agent calls -- all communication is mediated by the workflow engine
```

### Layer 5: Agent Marketplace

Pre-built agents that plug into any UC-powered store.

```
Install flow:
  npx @unifiedcommerce/cli add agent-seo-optimizer

What it does:
  - Registers an agent identity with appropriate permissions
  - Schedules a weekly workflow
  - The agent: scans all products, analyzes titles/descriptions for SEO quality,
    rewrites weak ones, submits for human approval
  - Dashboard shows: "SEO Agent improved 47 product titles this week"

Revenue model:
  - Free agents (open-source, community-built)
  - Premium agents (subscription, revenue share with UC)
  - Custom agents (built by vertical SaaS developers for their specific domain)

Example agents:
  - SEO Optimizer -- rewrites product titles/descriptions for search ranking
  - Pricing Agent -- monitors competitors, adjusts prices, runs A/B tests
  - Inventory Agent -- forecasts demand, triggers reorder alerts, optimizes stock levels
  - Customer Agent -- handles returns, answers product questions, processes exchanges
  - Marketing Agent -- drafts email campaigns, segments customers, schedules promotions
  - Analytics Agent -- generates weekly reports, identifies trends, flags anomalies
  - Compliance Agent -- checks product descriptions for regulatory compliance, flags issues
```

---

## The Admin UI Question Dissolves

Here is the deepest implication of the agentic architecture:

**The AI agent IS the admin UI.**

Traditional commerce platforms build elaborate admin dashboards with hundreds of pages: product editor, order list, inventory grid, pricing table, customer CRM, analytics dashboard, promotion builder. Each page is a form that a human fills out.

An agentic platform replaces most of this with a conversation:

```
Merchant: "Show me which products are losing money after shipping costs"
Agent: [calls analytics_query with revenue - shipping costs, grouped by product]
       "3 products have negative margin after shipping: ..."

Merchant: "Increase their prices by 15% starting Monday"
Agent: [calls pricing_bulk_update with 15% markup, validFrom: next Monday]
       "Price increases scheduled for 3 products. Would you like to review?"

Merchant: "Yes, show me"
Agent: [displays table: product, current price, new price, effective date]

Merchant: "Looks good. Also draft an email to VIP customers about the new collection"
Agent: [calls customer_segment with VIP filter, drafts email, queues for approval]
       "Email drafted for 247 VIP customers. Subject: 'First look: New Collection'. Approve to send?"
```

This does not eliminate the need for an admin UI entirely. Visual tasks (product image management, theme editing, dashboard viewing) still need a GUI. But **80% of admin operations become conversational**, which means:

1. UC does not need to build a 200-page admin dashboard to compete with Shopify
2. UC needs to build a **20-page admin UI** (visual tasks only) + a **chat interface** (everything else)
3. The chat interface works identically across all verticals (restaurant, fashion, fitness) because the agents adapt to the domain via plugins

---

## What UC Has vs What UC Needs

| Layer | Status | Gap |
|-------|--------|-----|
| Agent-Ready APIs (OpenAPI, MCP, SDK) | 80% done | Add remaining CRUD tools (pricing, promotions, customers). Improve error messages for agent consumption. |
| Agent Identity and Permissions | 20% done | Actor type exists, API keys exist. Need: agent registry, scoped permissions, value-bounded constraints. |
| Agent Actions (audit, reasoning, approval) | 30% done | Audit log exists. Need: agent reasoning field, approval workflow, action policies. |
| Agent Workflows (orchestration) | 0% | Need: workflow engine on top of job queue, DAG execution, inter-agent context. |
| Agent Marketplace | 0% | Need: agent packaging format, registry, install CLI. |

---

## Implementation Priority

### Now (part of Phase 1: Engine Production-Ready)

1. **Complete MCP tool coverage** -- add tools for: pricing (set price, create modifier), promotions (create, validate, deactivate), customers (list, get, update), webhooks (register, list). Target: every REST API operation has a corresponding MCP tool.
2. **Agent actor type** -- add `type: "agent"` to Actor. Agents get their own API keys with scoped permissions. The audit log records `actorType: "agent"` + `agentId`.
3. **Agent reasoning in audit log** -- add `reasoning: text` column to `commerce_audit_log`. MCP tool calls include an optional `reasoning` parameter that gets persisted.

### Phase 2 (6-12 months)

4. **Action approval workflow** -- configurable policies per agent, pending action queue, approve/reject API.
5. **Chat admin interface** -- a React component that wraps the MCP tools in a conversational UI. Ships with the admin starter.
6. **Plugin MCP tools convention** -- every plugin MUST export MCP tools. The `defineCommercePlugin` manifest already supports `mcpTools`. Make it a convention, not optional.

### Phase 3 (12-24 months)

7. **Workflow engine** -- DAG-based multi-agent orchestration on top of the job queue.
8. **Agent marketplace** -- packaging format, registry, `uc add agent-*` CLI.
9. **Pre-built agents** -- SEO, pricing, inventory, marketing agents.

---

## The Positioning Statement

**UnifiedCommerce: the agentic commerce kernel for vertical SaaS.**

Developers use UC to build domain-specific commerce platforms (restaurants, fashion, fitness, services). AI agents operate these platforms -- managing catalogs, optimizing prices, processing orders, analyzing performance. Humans supervise and approve.

The moat: as more agents run on UC, the platform accumulates domain-specific intelligence (what pricing strategies work for restaurants, what inventory patterns predict stock-outs for fashion). This intelligence feeds back into better agents, which attract more builders, which generates more data.

**Flywheel:**
```
Better agents --> More builders adopt UC --> More stores run on UC
      ^                                           |
      |                                           v
More domain intelligence <-- More commerce data generated
```

---

## What This Means for the Codebase Today

The agentic direction does NOT require a rewrite. It requires:

1. **MCP tools are not optional** -- they are the primary interface, not an afterthought. Every new feature ships with MCP tools alongside REST routes.
2. **The audit log becomes the agent action log** -- add `reasoning` and `approval_status` columns. Small migration, large strategic value.
3. **Agent identity is just a new Actor type** -- the auth middleware already supports multiple actor types (user, api_key). Adding `agent` is additive.
4. **The job queue becomes the workflow engine** -- `commerce_jobs` already supports: enqueue, retry, concurrency keys, deduplication. Workflow steps are jobs with dependencies.
5. **The plugin system already supports MCP tools** -- `defineCommercePlugin({ mcpTools: (ctx) => [...] })` exists. Make it a convention that every plugin ships tools.

The architecture is already agentic-ready. The gap is filling in the missing tools, adding agent identity, and building the orchestration layer.
