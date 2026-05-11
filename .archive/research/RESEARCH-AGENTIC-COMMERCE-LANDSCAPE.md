# Agentic Commerce Landscape Research

**Date:** 2026-03-18
**Purpose:** Deep research into what Google, Stripe, and the broader ecosystem are doing in agentic commerce. Informs UnifiedCommerce's strategic direction.

---

## 1. Two Competing Open Protocols

The agentic commerce space has crystallized around two competing open standards in the span of 4 months:

### 1.1 Stripe + OpenAI: Agentic Commerce Protocol (ACP)

**Announced:** September 29, 2025
**License:** Apache 2.0
**Spec:** agenticcommerce.dev

**What it is:** An open-source standard that defines how AI agents discover products, initiate checkout, and process payments on behalf of human buyers.

**Four participants in every ACP transaction:**

| Role | Responsibility |
|------|---------------|
| **Buyer** | Selects products via AI, grants payment permission |
| **AI Agent** | Interfaces with buyer, collects payment details, initiates checkout |
| **Business** | Receives checkout requests, accepts/declines, merchant of record |
| **Payment Provider** | Relays tokenized payment credentials securely |

**Key innovation: Shared Payment Tokens (SPTs)**
A new payment primitive that lets AI agents initiate payments without ever seeing the buyer's card number. SPTs are scoped to a specific merchant and cart total. The agent gets a token that says "this buyer authorized up to $X at this merchant" — the agent cannot use it elsewhere or for a different amount.

**Live deployments:**
- ChatGPT "Instant Checkout" — US users can purchase from Etsy businesses directly in chat
- 1M+ Shopify merchants onboarded (Glossier, Vuori, Spanx, SKIMS)
- Microsoft Copilot — shopping from Etsy, Urban Outfitters, Anthropologie
- Testing with Anthropic and Perplexity

**Stripe Agentic Commerce Suite (December 2025):**
- Product Discovery endpoint — syndicates real-time catalog data to AI agents
- Checkout and Order Management — built on Checkout Sessions API
- SPT payment processing with Radar fraud detection tuned for agentic transactions
- One-click activation in Stripe Dashboard
- Partners: URBN, Etsy, Ashley Furniture, Coach, Kate Spade, Revolve
- Platform integrations: Wix, WooCommerce, BigCommerce, Squarespace, commercetools, Mirakl

**Developer tools:**
- `stripe/agent-toolkit` (GitHub, MIT) — Python + TypeScript. Supports OpenAI Agent SDK, LangChain, CrewAI, Vercel AI SDK
- Stripe MCP Server — `https://mcp.stripe.com` (remote) or `npx @stripe/mcp@latest` (local). 30+ tools. Works with Claude Code, Cursor, VS Code, ChatGPT
- Stripe AI Foundation Model — trained on tens of billions of transactions for fraud detection

**Market projection:** $385B in US online spend via agentic purchasing by 2030.

---

### 1.2 Google: Universal Commerce Protocol (UCP)

**Announced:** January 11, 2026 at NRF 2026
**Spec:** developers.google.com/merchant/ucp

**What it is:** An open standard for agentic commerce that creates a common language for AI agents, businesses, and payment providers across the entire shopping journey (discovery, buying, post-purchase).

**Technical details:**
- Supports REST APIs, MCP binding, Agent Payments Protocol (AP2), and Agent2Agent (A2A) protocol
- Native SDKs in multiple languages
- Two integration paths: Native Checkout (direct) and Embedded Checkout (iframe-based)
- Merchant remains Merchant of Record and retains customer data ownership
- Tokenized payments
- Planned: multi-item carts, account linking, post-purchase support
- Open-source specs on GitHub

**Co-developed with:** Shopify, Etsy, Wayfair, Target, Walmart

**Endorsed by 20+ companies:** Adyen, American Express, Best Buy, Flipkart, Macy's, Mastercard, **Stripe**, The Home Depot, Visa, Zalando

**Note:** Stripe endorses BOTH protocols. This suggests the two may converge or become complementary (ACP for payment flow, UCP for full journey).

---

## 2. Google's Agentic Commerce Stack

Google has built a multi-layered agentic commerce stack:

### 2.1 AI Mode in Google Search (Conversational Shopping)

Powered by Gemini + Shopping Graph. Users ask natural-language queries (2-3x longer than traditional searches), get rich responses with product images, prices, reviews, and real-time inventory.

- Shopping Graph: **50 billion+ product listings**, 2 billion updated every hour
- Virtual try-on: users upload a photo and try on billions of apparel listings
- Available to Search Labs users in the US

### 2.2 Agentic Checkout (November 2025)

Shoppers set a target price on any product. Google monitors and **automatically purchases when the price drops**, using Google Pay. Always asks for user confirmation.

Initial merchants: Wayfair, Chewy, Quince, select Shopify merchants.

### 2.3 Business Agent

Shoppers chat with brands directly on Google Search — a virtual sales associate that answers product questions in the brand's voice.

Live with: Lowe's, Michael's, Poshmark, Reebok.

### 2.4 AI That Calls Stores (Duplex for Shopping)

An AI tool that phones local stores on behalf of shoppers to check product availability. Extends Google Duplex into commerce.

### 2.5 Gemini Enterprise for Customer Experience (NRF 2026)

| Agent | Capabilities |
|-------|-------------|
| **Shopping Agent** | Multimodal (text, voice, image, video). Autonomously builds carts, executes consented actions, cross-references product specs |
| **Food Ordering Agent** | Omnichannel (mobile, web, phone, kiosk, in-car). Intelligent upselling, operational analytics. 40+ languages |
| **CX Agent Studio** | Visual drag-and-drop builder for support workflows. AI-driven quality scoring |

Live customers: Kroger, Lowe's, Woolworths, Papa John's.

### 2.6 Vertex AI Search for Commerce

Google Cloud product providing Google-quality search, browse, recommendations, and conversational commerce for e-commerce sites.

- Conversational Commerce Agent (GA September 2025) — Gemini-powered multi-turn product discovery
- Albertsons: 85% of conversions started with open-ended questions
- Bed, Bath & Beyond: 5% improvement in revenue per visitor
- Google named Leader in 2025 Gartner Magic Quadrant for Search and Product Discovery

### 2.7 Market Impact

During Cyber Week 2025, AI agents influenced **20% of all orders** accounting for **$67 billion in global sales**. Retailers deploying branded AI agents grew sales **32% faster** than competitors.

---

## 3. Stripe's Developer Infrastructure for Agents

### 3.1 Agent Toolkit (`stripe/agent-toolkit`)

Official MIT-licensed library:

| Package | Purpose |
|---------|---------|
| `@stripe/agent-toolkit` | Stripe API integration via function calling (OpenAI, LangChain, CrewAI, Vercel AI SDK) |
| `@stripe/ai-sdk` | Stripe billing integration with Vercel's AI SDK |
| `@stripe/token-meter` | Connect Stripe billing to native SDKs from OpenAI, Anthropic, Google Gemini |

Capabilities: create payment links, manage product catalogs, issue virtual debit cards for one-time agent use, track metered usage, human-in-the-loop approval.

### 3.2 MCP Server

- Remote: `https://mcp.stripe.com` (OAuth-secured)
- Local: `npx -y @stripe/mcp@latest --api-key=YOUR_SECRET_KEY`
- Claude Code: `claude mcp add --transport http stripe https://mcp.stripe.com/`
- 30+ tools: customers, payment intents, payment links, invoices, subscriptions, refunds, disputes, products/prices

### 3.3 Payments Foundation Model

First AI model trained specifically for payments (tens of billions of transactions). Increased card-testing attack detection by 64%.

### 3.4 Stablecoin Payments for AI Agents

USDC on Base blockchain for automated agent-to-agent payments.

---

## 4. The Emerging Protocol Stack

The agentic commerce landscape has converged around a layered protocol stack as of March 2026:

| Layer | Protocol(s) | Maintainer | Status |
|-------|------------|------------|--------|
| **Agent-to-Tool** | MCP (Model Context Protocol) | AAIF / Linux Foundation | 97M+ monthly SDK downloads, 10K+ servers |
| **Agent-to-Agent** | A2A (Agent2Agent Protocol) | Linux Foundation | v0.3, 150+ organizations |
| **Agent-to-Commerce** | ACP (Agentic Commerce Protocol) | OpenAI + Stripe | Live (ChatGPT + Etsy/Shopify), v4 |
| **Full Shopping Journey** | UCP (Universal Commerce Protocol) | Google | Announced Jan 2026 at NRF |
| **Agent-to-Payment** | AP2, x402, Visa Trusted Agent, Mastercard Agent Pay | Google + payment networks | AP2: 60+ orgs |
| **Agent Identity** | AIMS (IETF draft), SPIFFE, OAuth 2.0 | IETF, OpenID Foundation, NIST | Drafts, Feb-Mar 2026 |
| **Agent Discovery (Web)** | ANP, WebMCP, Agent Cards | W3C Community Groups | Early stage |
| **Agent Project Config** | AGENTS.md | AAIF / Linux Foundation | 60K+ projects |
| **Governance** | Agentic AI Foundation (AAIF) | Linux Foundation | Platinum: AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI |

### 4.1 MCP (Model Context Protocol)

Launched by Anthropic November 2024. Donated to the **Agentic AI Foundation (AAIF)** under the Linux Foundation in December 2025 (co-founded by Anthropic, Block, OpenAI).

- **97M+ monthly SDK downloads**, 10,000+ active MCP servers, hundreds of AI clients
- Adopted by OpenAI (March 2025), Google DeepMind, Microsoft Copilot, Cursor, VS Code, Gemini
- **2026 roadmap:** Stateless Streamable HTTP transport, scalable session handling, enterprise-managed auth (SSO), audit trails

UC already has MCP tools. This is the right foundation.

### 4.2 A2A (Agent2Agent Protocol) -- Google

Announced April 2025, contributed to Linux Foundation June 2025. v0.3 released July 2025.

- Enables communication between **opaque, independent AI agent systems** built on different frameworks
- Complements MCP (MCP = agent-to-tool, A2A = agent-to-agent)
- **Agent Cards** -- JSON metadata declaring identity, capabilities, skills, authentication requirements
- **Tasks** -- stateful work units with lifecycle (working, input-required, completed, failed)
- Transport: JSON-RPC 2.0 over HTTP/WebSocket, gRPC
- 150+ organizations including Atlassian, Box, LangChain, MongoDB, PayPal, Salesforce, SAP

**UC implication:** A UC-powered store could expose an A2A Agent Card so other agents can discover and transact with it programmatically.

### 4.3 ACP (Agentic Commerce Protocol) -- OpenAI + Stripe

The definitive commerce-specific agent protocol. Apache 2.0. Currently v4 (January 2026).

**Version history:**
| Version | Date | Features |
|---------|------|----------|
| v1 | 2025-09-29 | Core checkout flow |
| v2 | 2025-12-12 | Fulfillment enhancements |
| v3 | 2026-01-16 | Capability negotiation |
| v4 | 2026-01-30 | Extensions, discounts, payment handlers |

**Two APIs:**
1. **Checkout API** (`openapi.agentic_checkout.yaml`) -- product discovery + transaction initiation
2. **Delegate Payment API** (`openapi.delegate_payment.yaml`) -- secure payment token exchange (SPTs)

**Key concepts:** Capability negotiation between agents and merchants, extensions framework (discounts, loyalty), payment handlers abstracting multiple methods. Agent is never merchant of record.

GitHub: `agentic-commerce-protocol/agentic-commerce-protocol`
Developer docs: `developers.openai.com/commerce`

### 4.4 AP2 (Agent Payments Protocol) -- Google

Open protocol with **60+ organizations** (Adyen, Amex, Ant International, Coinbase, Etsy, Mastercard, PayPal, Revolut, Salesforce, UnionPay, Worldpay).

**Mandate System (core innovation):**
- **Intent Mandate** -- captures user's request ("find me white running shoes")
- **Cart Mandate** -- locks in exact items + price upon approval
- **Payment Mandate** -- shared with payment network/issuer

All mandates are **tamper-proof, cryptographically signed** (minimum ECDSA P-256). Agents never access PCI data or PII.

### 4.5 Other Payment Protocols

| Protocol | Owner | Mechanism |
|----------|-------|-----------|
| **Visa Trusted Agent Protocol** | Visa + Cloudflare | HTTP Message Signatures to distinguish legit agents from bots |
| **Mastercard Agent Pay** | Mastercard | Agentic token framework for trusted AI transactions |
| **x402** | Coinbase + Cloudflare + Google + Visa | Activates HTTP 402 status code for on-chain agent payments (USDC) |

### 4.6 Agent Identity Standards

This is the least mature but most critical layer:

- **NIST** -- concept paper "Accelerating Adoption of Software and AI Agent Identity" (Feb 2026). Adapting OAuth/OIDC for agents.
- **IETF** -- draft `draft-klrc-aiagent-auth-00` (Mar 2026). 26-page Agent Identity Management System (AIMS) composing WIMSE, SPIFFE, OAuth 2.0.
- **OpenID Foundation** -- whitepaper "Identity Management for Agentic AI". Key finding: SPIFFE provides workload identity but agents need enriched metadata (agent_model, agent_provider, agent_version).
- **AuthZEN** -- OpenID Authorization API 1.0 (Final Spec, Jan 2026). Transport-agnostic policy evaluation API directly applicable to agent authorization.

**UC implication:** Agent identity is unsolved at the standards level. UC's approach of agent as a first-class Actor type with scoped API keys is pragmatically correct. Standards will converge on something similar to OAuth 2.0 client credentials + agent metadata.

### 4.7 Key Observation

**MCP and A2A are complementary** (tools vs inter-agent). **ACP and UCP may converge** (Stripe endorses both). The payments layer is fragmenting (AP2, ACP, x402, Visa, Mastercard) but all share the principle of **tokenized, scoped payment authorization where the agent never sees card data**.

UCP explicitly supports MCP binding -- meaning UC's existing MCP tools can plug directly into the UCP ecosystem without modification.

---

## 5. What This Means for UnifiedCommerce

### 5.1 UC Is Already Positioned Correctly

UC's existing architecture aligns with where the industry is going:

| Industry Direction | UC Status |
|-------------------|-----------|
| Structured product APIs for agent discovery | Done (OpenAPI, 129 paths) |
| MCP tools for AI agent operation | Done (10 core tools + plugin tools) |
| Semantic analytics for agent grounding | Done (COMMERCE_AGENT_SYSTEM_PROMPT) |
| Checkout API for programmatic ordering | Done (POST /api/checkout) |
| Plugin architecture for vertical customization | Done (defineCommercePlugin) |

### 5.2 What UC Must Build

| Capability | Why | Priority |
|-----------|-----|----------|
| **ACP/UCP product discovery endpoint** | AI agents (ChatGPT, Copilot, Gemini) need a standardized way to discover products from UC-powered stores. Implement the ACP/UCP product syndication spec. | P0 |
| **Shared Payment Token support** | SPTs are how agents pay securely. UC's Stripe adapter needs to accept SPTs alongside regular payment intents. | P0 |
| **Agent identity (Actor type: "agent")** | Both ACP and UCP distinguish agents from human users. UC needs first-class agent identity. | P1 |
| **UCP Native Checkout endpoint** | Implement the UCP checkout spec so Google Shopping agents can transact with UC-powered stores. | P1 |
| **Product feed for Shopping Graph** | UC stores should automatically syndicate to Google Shopping Graph (50B+ listings). Structured data (schema.org Product) on storefront pages. | P1 |
| **MCP server as a package** | UC's MCP tools should be publishable as a standalone MCP server that Claude Code, Cursor, ChatGPT can connect to. | P2 |

### 5.3 The Strategic Opportunity

The protocols (ACP, UCP) define how agents DISCOVER and PAY. They do NOT define how the commerce backend operates. That is UC's layer.

```
Google/Stripe protocols:  Agent <-> Discovery + Payment
UnifiedCommerce:          Discovery + Payment <-> Backend (catalog, inventory, orders, fulfillment)
```

UC is the engine BEHIND the protocol endpoints. When a ChatGPT agent discovers a product via ACP, the product data comes from UC's catalog API. When the agent initiates checkout via SPT, UC's checkout pipeline processes the order.

**This means UC does not compete with ACP or UCP. UC implements them.** Every UC-powered store automatically becomes accessible to every AI shopping agent in the world — ChatGPT, Copilot, Gemini, Perplexity — through standard protocol endpoints.

### 5.4 The Flywheel (Updated)

```
UC implements ACP + UCP protocols
    |
    v
Every UC-powered store is discoverable by AI shopping agents
    |
    v
More sales flow through UC-powered stores (agent-driven GMV)
    |
    v
More vertical SaaS builders choose UC (proven agent commerce revenue)
    |
    v
More stores on UC --> more agent traffic --> more data --> better agents
```

### 5.5 Implementation Roadmap

**Phase 1 (Now): Protocol Compatibility**
1. Add ACP product discovery endpoint to core (`GET /api/acp/products`)
2. Add SPT acceptance to Stripe adapter
3. Add `schema.org/Product` structured data helper for storefronts
4. Publish UC MCP server as standalone package

**Phase 2 (3-6 months): Full Protocol Support**
1. Implement UCP Native Checkout spec
2. Implement UCP post-purchase endpoints (order status, returns)
3. Google Merchant Center integration (Shopping Graph syndication)
4. Agent identity and audit trail

**Phase 3 (6-12 months): Agent-Native Features**
1. Agent workflows (multi-agent orchestration)
2. Agent marketplace (installable commerce agents)
3. Agentic analytics (agent-driven insights and actions)
4. Cross-protocol support (ACP + UCP + future protocols)

---

## 6. Competitive Landscape (Commerce AI)

### Shopify (Most Advanced)

Shopify made the most aggressive move with 150+ AI updates in their Winter '26 "RenAIssance Edition":

- **Sidekick** — Conversational AI admin assistant. Multi-step reasoning, creates Shopify Flow automations from plain language, writes ShopifyQL queries, creates discount codes/shipping rates, generates content. **Sidekick App Extensions** let third-party apps expose data/actions to Sidekick.
- **Shopify Magic** — AI product descriptions, auto-tagging from images, SEO metadata, background removal/generation, email content. Free on all plans.
- **Agentic Storefronts** (Dec 2025) — Products syndicated to ChatGPT, Perplexity, Microsoft Copilot. **Shopify Catalog API**: agents search across billions of products. **Checkout Kit**: enables search-to-purchase entirely within the AI agent.
- **Dev MCP Server** — AI agents scaffold apps, run GraphQL, generate validated code. Works in Cursor and Claude Code.
- ACP partner (1M+ merchants), UCP co-developer.

### Medusa (Closest Open-Source Competitor)

Medusa (29K GitHub stars) is investing heavily in AI-first development:

- **Bloom** — AI Commerce Assistant. Go from idea to online shop in a single prompt. Generates complete store (frontend + admin + backend).
- **AI Solutions Engineer** (built with Mastra) — Single-agent architecture (they tried multi-agent and abandoned it due to coordination problems). Feeds entire codebase into context using Google Gemini. Processes prompts like "build me a product review feature" and generates end-to-end PRs. Deployed via "AI Tickets" in Medusa Cloud. Handling conversations at 4-5 million tokens.
- **Claude Code plugins** — `medusa-dev` plugin with integrated MCP server for documentation queries. Can build product reviews, abandoned cart features.
- **MCP Server** — connects to AI tools, provides documentation context for accurate code generation.

**Key insight from Medusa:** they tried multi-agent and abandoned it. Single agent with full codebase context works better. This validates UC's approach of rich MCP tools over complex agent orchestration.

### commercetools (Enterprise Agent Infrastructure)

- **AI Hub** (early access, Nov 2025) — Centralized platform with purpose-built modules for GenAI channels. Merchants configure modules to make commerce data discoverable in AI channels.
- **Commerce MCP** — Transforms enterprise commerce into agent-ready ecosystems. Backend services securely accessible to AI agents via MCP.
- **Developer MCP** (early access) — Embeds commercetools APIs directly into IDEs and AI copilots.
- **Smart Data Modeler** (early access) — AI generates product data models from catalogs.
- **Agentic Jumpstart** — Pre-built enterprise solution for agentic commerce.
- Supports Stripe ACP, endorsed UCP.
- Co-founder predicts **30% of digital commerce will be driven entirely by intelligent agents by 2030**.

### BigCommerce

- Stripe Agentic Commerce Suite integration. UCP endorsed.
- Focus on infrastructure readiness (flexible APIs, scheduled syncs, rollback workflows) rather than building own AI.
- Partnerships with Perplexity, Microsoft, Google, PayPal for agentic commerce.

### Amazon Rufus (Most Agentic at Scale)

The largest deployed AI shopping agent by user count:
- **250M+ users**, monthly active users up 149%, interactions up 210% YoY
- Projected **$700M+ in operating profits** in 2025, reaching $1.2B by 2027
- **Auto-buy**: set target price, Rufus automatically purchases when price drops. 24h cancellation window. 6-month duration.
- **Buy for Me**: agent purchasing from external merchants
- Account memory (shopping history, family, pets, dietary preferences)
- Visual search, handwritten grocery list recognition, 30/90-day price tracking
- Expanding to 13+ new markets

### Perplexity

- **Buy with Pro**: one-click checkout for Pro users, powered by Shopify integration
- **Snap to Shop**: photo-to-product visual search
- **Free Shopping Agent**: all US users with PayPal, 5,000+ merchants. Unlike OpenAI (which charges fees), Perplexity's model is free.
- Testing Stripe ACP integration

### ChatGPT / OpenAI (Struggling)

- **Shopping Research**: product recommendations with buyer's guides
- **Instant Checkout** with Stripe ACP: buy from Etsy sellers in chat
- **However**: OpenAI **scaled back shopping plans in early 2026**. Users browsed but didn't convert. As of Feb 2026, no system for collecting state sales taxes — a regulatory blocker.
- This is significant: **even OpenAI can't make agentic checkout work easily**. The platform that solves merchant-side complexity wins.

---

## 7. Agentic Commerce Startup Ecosystem

**Market size:** McKinsey projects **$1 trillion** in US retail revenue from agentic commerce by 2030. TAM projected at $1.7 trillion by 2030 (67% CAGR from $136B in 2025). AI agent startups raised **$3.8 billion** in 2024 (nearly 3x 2023).

**90+ companies** shaping the space:

| Segment | Notable Startups |
|---------|-----------------|
| **Payment rails for agents** | Basis Theory, Nekuda, Skyfire (~$50M combined), Firmly, Henry Labs, Rye |
| **Agent identity/auth** | Anon, Neural Payments, Stytch |
| **Agent-optimized product data** | Merchkit, Catalog, Profound, Bluefish, Chainshift |
| **Browser/API orchestration** | Browserbase, Browser Use, Skyvern, Composio, Wildcard |
| **Agent builder platforms** | Gett, Latinum, Listo, Vypr |
| **AI fashion/shopping** | Phia ($8M raise), OneOff, Daydream, Alta, Doji |
| **Procurement/B2B** | Omnea, Zip, Levelpath, Magnetic, Didero |
| **GEO (Generative Engine Optimization)** | FERMAT (AI Search Commerce Engine) |

**Key stat:** 95% of AI agent projects fail to reach production. The opportunity is in providing **robust, production-ready commerce primitives** that agents can reliably consume, not in building the agents themselves.

---

## 8. AI Product Discovery Trends

- 73% of consumers already use AI in their shopping journey
- "Recommend products" is the #1 task users trust AI to handle
- Over 50% of Google searches now end without a click
- AI commerce site visits up **4,700% YoY**
- Product data is now "operational infrastructure" — agents cannot recommend what they cannot interpret
- Headless commerce market: $1.74B in 2025, projected **$7.16B by 2032** (22.4% CAGR)
- Headless is the natural fit for agentic commerce: API-first data flows directly to agents without needing a website

---

## Sources

### Stripe
- [Introducing the Agentic Commerce Suite](https://stripe.com/blog/agentic-commerce-suite)
- [Developing an Open Standard for Agentic Commerce](https://stripe.com/blog/developing-an-open-standard-for-agentic-commerce)
- [Stripe Powers Instant Checkout in ChatGPT](https://stripe.com/newsroom/news/stripe-openai-instant-checkout)
- [Stripe Agent Toolkit (GitHub)](https://github.com/stripe/agent-toolkit)
- [Stripe MCP Documentation](https://docs.stripe.com/mcp)
- [Add Stripe to Agentic Workflows](https://docs.stripe.com/agents)
- [Top Product Updates from Sessions 2025](https://stripe.com/blog/top-product-updates-sessions-2025)

### Google
- [A new era of agentic commerce is here (Google Cloud Blog)](https://cloud.google.com/transform/a-new-era-agentic-commerce-retail-ai)
- [Universal Commerce Protocol Developer Guide](https://developers.google.com/merchant/ucp)
- [Google announces UCP (TechCrunch, Jan 2026)](https://techcrunch.com/2026/01/11/google-announces-a-new-protocol-to-facilitate-commerce-using-ai-agents/)
- [Gemini Enterprise for CX (Press Release, Jan 2026)](https://www.googlecloudpresscorner.com/2026-01-11-Google-Cloud-Brings-Shopping-and-Customer-Service-Together-with-Gemini-Enterprise-for-Customer-Experience)
- [Google augments AI shopping (TechCrunch, Nov 2025)](https://techcrunch.com/2025/11/13/google-expands-ai-shopping-with-conversational-search-agentic-checkout-and-an-ai-that-calls-stores-for-you/)
- [Vertex AI Search for Commerce docs](https://docs.cloud.google.com/retail/docs/what-is-it)
- [Shopping on Google: AI Mode updates from I/O 2025](https://blog.google/products-and-platforms/products/shopping/google-shopping-ai-mode-virtual-try-on-update/)

### Market Data
- Stripe projects $385B in US agentic purchasing by 2030
- Cyber Week 2025: AI agents influenced 20% of all orders, $67B in global sales
- Retailers with branded AI agents grew sales 32% faster than competitors
