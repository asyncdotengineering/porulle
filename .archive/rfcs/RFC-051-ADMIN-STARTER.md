# RFC-051: Admin Dashboard Starter

## Status: Draft

## TL;DR

Build a full admin dashboard for UnifiedCommerce using TanStack Start + shadcn/ui. UX is the north star. Design for daily operations (not setup). Provision for invisible AI that reduces cognitive load without adding complexity.

---

## Research Summary

Six parallel research threads were conducted. Key findings:

### Ecommerce Admin UX Pain Points (10 workflow areas)

The **#1 cross-cutting theme**: admin panels were designed for store *setup*, not daily *operations*. The operational workflows (process orders, handle returns, adjust inventory) are afterthoughts bolted onto setup-oriented UIs.

| Pain Point | Impact | Our Response |
|-----------|--------|-------------|
| Too many steps for basic lookups (5-7 clicks to find an order) | Hours/week lost to navigation | Command palette (Cmd+K) as primary navigation. Every entity reachable in 2 keystrokes. |
| No bulk order operations | Hundreds of orders processed one at a time | Bulk selection + floating action bar on every list view |
| Stale lists after state changes | Merchants lose trust in the screen | Optimistic updates + TanStack Query cache invalidation |
| Returns are 65% manual (Shopify stat) | 30% of item price per return | First-class returns queue with state machine (not a sub-action of orders) |
| Multi-channel inventory desync | 15 hours/week manual tracking | Real-time inventory via webhook-driven updates |
| CSV import/export hell | 15 hours/month, $2,000 in errors | Drag-and-drop import with validation preview + undo |
| Variant editing at scale | Hours for seasonal price changes | Spreadsheet-like inline data grid (Medusa's best feature — steal it) |
| Data without actionability | Decision paralysis | AI-narrated insights + contextual "here's what to do" prompts |
| Dashboard overload / decision fatigue | Cognitive paralysis | Role-based views + progressive disclosure + 5-second rule |
| No role-based views | Everyone sees the same irrelevant screen | Dynamic dashboard per role (admin, staff, warehouse, marketing) |

### Medusa Admin Architecture (lessons learned)

| What they got right | What they got wrong |
|--------------------|-------------------|
| SDK → TanStack Query hooks → Components (clean layering) | Cannot modify existing pages (only inject before/after) |
| 100+ widget injection zones | Performance degrades at 400+ products |
| `defineWidgetConfig` / `defineRouteConfig` (elegant DX) | Excessive notification polling (no WebSocket/SSE) |
| i18n (32 languages including RTL) | Coupled to backend build (hard to decouple) |
| cmdk command palette | No AI features for merchants (only for developers) |
| Data grid for bulk variant editing | Cannot customize navigation or layout |
| Full TypeScript end-to-end | Auth is inflexible |

### TanStack Start (framework evaluation)

**Verdict: Production-ready for admin panels.**

| Pro | Con |
|-----|-----|
| End-to-end type-safe routing (invalid routes are compile errors) | RC status — lock versions |
| `createServerFn` with Zod validation + middleware chains | Auth `beforeLoad` runs on every navigation (perf hit) |
| Client-first SPA model = perfect for rich admin interactivity | No React Server Components (irrelevant for admin) |
| Better Auth has official TanStack Start integration | Thinner ecosystem than Next.js |
| shadcn/ui has official TanStack Start installation | Build tool migration (Vinxi → Vite) was breaking |
| Nitro deployment to Vercel/Bun/Node/Cloudflare | |
| Multiple admin dashboard starters already exist | |

### Invisible AI Patterns (20 patterns researched)

**Design principle: "Ambient over conversational."** The best AI features are not chatbots. They are better defaults, smarter sorting, and contextual warnings injected into existing workflows.

| Pattern | Visibility | Example |
|---------|-----------|---------|
| Predictive reorder points | Invisible | "Reorder suggested: 200 units by Apr 12" inline on inventory row |
| Stock anomaly detection | Invisible | Warning icon on SKU selling 3x faster than baseline |
| Fraud risk scoring | Invisible (95%) / Visible (5%) | Green/amber/red indicator on order row |
| Smart fulfillment routing | Invisible | Pre-selected warehouse (closest, in stock) |
| RFM customer segmentation | Invisible | Segment badge on customer list (auto-computed) |
| Churn prediction | Invisible + contextual | "45 days since last purchase (avg: 20 days)" on customer profile |
| Auto-generated product descriptions | Visible (one-click) | "Generate" button inline in description editor |
| Smart category suggestions | Invisible | Pre-populated tags on new product |
| KPI anomaly alerts | Invisible | Toast: "Conversion dropped 23% in 2 hours" |
| AI-narrated insights | Invisible | Text card: "Revenue up 12%, driven by new collection" |

**Provision strategy**: Build the UI with `_context` slots where AI insights can be injected later. The MCP tools already exist. The AI features are additive — they fill existing slots, not new screens.

### UI Component Recommendation

**shadcn/ui + TanStack ecosystem.** Full ownership (vendored source), Radix primitives for accessibility, TanStack Table for data-dense views, Recharts for charts, cmdk for command palette.

| Component | Library |
|-----------|---------|
| UI primitives | shadcn/ui (Radix + Tailwind) |
| Tables | TanStack Table v8 + TanStack Virtual |
| Forms | React Hook Form + Zod |
| Charts | Recharts (shadcn-native) |
| State | TanStack Query (server) + Zustand (client) |
| Routing | TanStack Start (file-based, type-safe) |
| Command palette | cmdk (shadcn Command) |
| Drag-and-drop | @dnd-kit |
| Keyboard shortcuts | react-hotkeys-hook |

### UC API Surface (mapped for admin)

17 core route groups + 15 plugin route groups + 20 MCP tools. 146 API operations total. Every admin page maps to existing API endpoints — no new backend work needed.

---

## Product Requirements Document

### Vision

**The admin that gets out of your way.** Designed for the merchant who processes 30 orders before lunch, not the developer who sets up the store once. Every daily task should be completable in fewer clicks than any competitor. AI augments — invisibly — without adding cognitive load.

### User Personas

| Persona | Daily tasks | Key need |
|---------|------------|----------|
| **Store Owner** | Check revenue, review orders, spot problems | Dashboard with actionable insights, not data dumps |
| **Operations Manager** | Process orders, manage fulfillment, handle returns | Bulk operations, keyboard shortcuts, fast navigation |
| **Warehouse Staff** | Pick/pack/ship, adjust inventory, receive stock | Inventory-focused view, barcode scanning, minimal UI |
| **Marketing Manager** | Create promotions, review analytics, manage catalog | Promotion builder, campaign analytics, customer segments |
| **Customer Support** | Look up orders, process refunds, update addresses | Single-pane customer view with full order history |

### Information Architecture

```
Dashboard (role-based)
├── Orders
│   ├── All Orders (list + bulk actions)
│   ├── Returns & Refunds (first-class queue)
│   └── Fulfillment
├── Catalog
│   ├── Products (list + inline edit grid)
│   ├── Categories & Brands
│   ├── Variants (spreadsheet editor)
│   └── Import / Export
├── Inventory
│   ├── Stock Levels (per warehouse)
│   ├── Adjustments
│   └── Warehouses
├── Customers
│   ├── All Customers (with segment badges)
│   ├── Customer Groups
│   └── Customer Detail (single-pane view)
├── Promotions
│   ├── Active Promotions
│   ├── Create Promotion
│   └── Promotion Analytics
├── Analytics
│   ├── Overview (AI-narrated)
│   ├── Revenue
│   ├── Products
│   └── Customers
├── Settings
│   ├── Store
│   ├── Users & Permissions
│   ├── API Keys
│   ├── Webhooks
│   ├── Audit Log
│   └── Jobs
└── [Plugin pages injected here]
```

### Page Requirements (MVP — one sprint)

#### 1. Dashboard
- Role-based: different cards for owner vs. staff vs. warehouse
- KPI cards: revenue (today/week/month), orders, average order value, conversion
- AI slot: narrated insight text card (placeholder for now, MCP-powered later)
- Quick actions: "Fulfill 5 orders", "3 low-stock items", "2 pending returns"
- Recent orders list (last 10)

#### 2. Orders List
- Filterable by status, date range, customer, payment method
- Bulk select + action bar (mark fulfilled, print labels, export)
- Status badges with color coding
- Inline status transition (dropdown, not separate page)
- Click to open detail panel (slide-over, not page navigation)

#### 3. Order Detail
- Full order info: items, totals, payment, shipping, timeline
- Status transition buttons (confirm → process → fulfill)
- Fulfillment tracking input
- Refund / return initiation
- AI slot: fraud risk indicator (placeholder)
- Customer info card with link to full profile
- Audit trail for this order

#### 4. Products List
- Grid + list view toggle
- Filterable by type, status, category, brand
- Bulk select + publish/archive/delete
- Quick-add product (slide-over form)
- AI slot: "3 products need descriptions" prompt

#### 5. Product Detail / Editor
- Tabbed: General, Attributes, Variants, Pricing, Inventory, Media, SEO
- Inline variant grid (spreadsheet-like, Medusa-style)
- Image upload with drag-and-drop reordering
- AI slot: "Generate description" button

#### 6. Inventory Dashboard
- Stock levels per product per warehouse
- Low-stock alerts (red badges)
- Quick adjust (inline +/- buttons)
- AI slot: reorder suggestions

#### 7. Customers List
- Search + filter by segment, group, date
- AI slot: segment badges (Champions, At Risk, etc.)
- Click to customer detail panel

#### 8. Customer Detail
- Single-pane: profile, addresses, order history, loyalty points
- AI slot: churn prediction indicator
- Quick actions: create order, send email

#### 9. Promotions
- Active promotions list with status/usage/revenue
- Create wizard (type → rules → schedule → review)
- AI slot: "Similar to SUMMER20 which generated $X" suggestion

#### 10. Analytics
- Revenue chart (daily/weekly/monthly)
- Top products table
- Customer acquisition chart
- AI slot: narrated summary card

#### 11. Settings
- Store config (name, currency, shipping)
- Users + roles
- API key management (create/revoke from `apiKeyScopes`)
- Webhook management
- Audit log viewer
- Job queue monitor

#### 12. Global UI
- **Command palette** (Cmd+K): search orders, products, customers by name/number/email
- **Sidebar navigation** with collapsible groups
- **Breadcrumbs** on every page
- **Toast notifications** for mutations
- **Dark mode**
- **Keyboard shortcuts** for common actions (N for new, E for edit, / for search)

---

## Technical Architecture

### Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | TanStack Start | Type-safe routing, client-first SPA, Better Auth integration |
| UI | shadcn/ui | Vendored components, Radix accessibility, Tailwind styling |
| Tables | TanStack Table + Virtual | Virtualized, sortable, filterable, inline-editable |
| Forms | React Hook Form + Zod | Validation, multi-step, error handling |
| Charts | Recharts | shadcn-native, good enough for admin dashboards |
| State | TanStack Query + Zustand | Server state + client state separation |
| Auth | Better Auth sessions | Cookie-based, org-scoped, role-aware |
| API client | openapi-fetch typed with generated paths | Same pattern as store starter |
| Command palette | cmdk (shadcn Command) | Keyboard-first navigation |

### Auth Flow

```
Login page (email/password) → Better Auth session → cookie set
                                                    → sidebar shows role-appropriate nav
                                                    → every server function checks session
                                                    → API calls include session cookie
```

No API keys for the admin. Session-based auth only. The admin user signs in, gets a cookie, and all subsequent requests use that session.

### Data Flow

```
TanStack Start route
  └── beforeLoad: check session (redirect to /login if none)
  └── loader: fetch data via server function
        └── server function: call UC API with session cookie
              └── UC API: authenticate via Better Auth session
              └── return typed response
  └── component: render with useLoaderData()
  └── mutations: server functions with optimistic updates via TanStack Query
```

### Extension Model (learned from Medusa, improved)

```ts
// Plugin can inject widgets AND override page sections
defineAdminWidget({
  zone: "order.detail.sidebar",
  component: FraudScoreWidget,
  // Weight controls ordering within a zone
  weight: 10,
});

// Plugin can add navigation items
defineAdminRoute({
  path: "/marketplace/vendors",
  label: "Vendors",
  icon: StoreIcon,
  group: "Marketplace",
  component: VendorsPage,
});

// Plugin can override an existing section (Medusa can't do this)
defineAdminOverride({
  target: "order.detail.fulfillment",
  component: CustomFulfillmentSection,
});
```

### AI Provision (invisible slots)

Every page has named slots where AI content can be injected later:

```tsx
// In the order detail page
<AISlot name="order.fraud-risk" context={{ orderId }} />
<AISlot name="order.fulfillment-suggestion" context={{ orderId }} />

// AISlot renders nothing by default. When an AI provider is configured,
// it calls the MCP tool and renders the result inline.
// The merchant never knows AI is helping unless they look closely.
```

---

## Project Structure

```
uc-admin-starter/
├── app/
│   ├── routes/
│   │   ├── __root.tsx           # Auth check + layout
│   │   ├── index.tsx            # Dashboard
│   │   ├── login.tsx            # Login page
│   │   ├── orders/
│   │   │   ├── index.tsx        # Orders list
│   │   │   └── $orderId.tsx     # Order detail
│   │   ├── catalog/
│   │   │   ├── index.tsx        # Products list
│   │   │   └── $productId.tsx   # Product editor
│   │   ├── inventory/
│   │   │   └── index.tsx        # Inventory dashboard
│   │   ├── customers/
│   │   │   ├── index.tsx        # Customers list
│   │   │   └── $customerId.tsx  # Customer detail
│   │   ├── promotions/
│   │   │   ├── index.tsx        # Promotions list
│   │   │   └── new.tsx          # Create promotion wizard
│   │   ├── analytics/
│   │   │   └── index.tsx        # Analytics overview
│   │   └── settings/
│   │       ├── index.tsx        # Store settings
│   │       ├── users.tsx        # Users & permissions
│   │       ├── api-keys.tsx     # API key management
│   │       ├── webhooks.tsx     # Webhook management
│   │       ├── audit.tsx        # Audit log
│   │       └── jobs.tsx         # Job queue
│   └── components/
│       ├── layout/              # Sidebar, header, breadcrumbs
│       ├── data-table/          # Reusable table with filters + bulk actions
│       ├── command-palette/     # Cmd+K global search
│       ├── ai-slot/             # Invisible AI injection points
│       └── forms/               # Reusable form patterns
├── lib/
│   ├── api.ts                   # openapi-fetch client with session auth
│   ├── auth.ts                  # Better Auth client + session helpers
│   └── hooks/                   # TanStack Query hooks per entity
├── commerce.config.ts           # UC engine config (same pattern as store starter)
├── vite.config.ts               # TanStack Start + Vite
└── .claude/skills/unified-commerce/
```

---

## Implementation Plan

### Sprint 1 (one dev sprint — 2 weeks)

**Week 1:**
1. Scaffold TanStack Start + shadcn/ui + Better Auth
2. Login page + session auth + protected routes
3. Layout: sidebar nav + header + command palette
4. Dashboard with KPI cards (revenue, orders, AOV)
5. Orders list with filters + bulk selection
6. Order detail slide-over with status transitions

**Week 2:**
7. Products list + quick-add form
8. Product editor (tabbed: general, variants, pricing, media)
9. Inventory dashboard with stock levels + quick adjust
10. Customers list + detail view
11. Settings pages (store, API keys, webhooks, audit, jobs)
12. Analytics overview (revenue chart, top products)

### Sprint 2 (post-MVP)
- Promotions builder
- Returns queue
- Inline variant data grid
- Import/export with validation
- Dark mode polish
- Keyboard shortcuts
- AI slot implementations (connect to MCP tools)
- Plugin extension system (defineAdminWidget, defineAdminRoute, defineAdminOverride)

---

## Success Metrics

| Metric | Target | How measured |
|--------|--------|-------------|
| Time to find an order | < 3 seconds | Cmd+K → type order number → result |
| Clicks to fulfill an order | ≤ 3 | Select order → click Fulfill → confirm |
| Time to create a product | < 2 minutes | Quick-add form → publish |
| Dashboard load time | < 1 second | Lighthouse / Web Vitals |
| tsc --noEmit | 0 errors | CI check |

---

## References

- Ecommerce admin UX pain points research (10 workflow areas, 5 platforms)
- Medusa admin architecture review (tech stack, extension model, strengths/weaknesses)
- TanStack Start framework evaluation (maturity, routing, auth, deployment)
- Invisible AI patterns for commerce (20 patterns across 6 domains)
- UI component systems comparison (shadcn/ui vs refine vs react-admin vs tremor)
- UC API surface mapping (146 operations across 17 core + 15 plugin route groups)
