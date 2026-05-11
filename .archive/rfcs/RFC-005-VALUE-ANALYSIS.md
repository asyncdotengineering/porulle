# RFC-005 Value Analysis: Technical, DX, and Business

## First Principles: What are the three stakeholders actually asking?

**The engine asks:** "Am I correct? Can you trust me with money?"

**The developer asks:** "Can I build what my client needs without forking your code or rewriting your internals?"

**The merchant asks:** "Does this protect my revenue, my customers, and my operations?"

Every part of RFC-005 answers at least two of these. Let me walk through the evidence.

---

## Technical: Can I trust this system with money?

Right now, the answer is no. There are two concrete, verified bugs in the most critical path of any commerce system.

### Bug 1: Inventory oversell is not theoretical

I verified in `packages/core/src/modules/inventory/service.ts` (the `reserve()` method, lines 144-204). The method reads the current inventory level, checks if `quantityOnHand - quantityReserved >= requested`, then writes the updated reservation. These are two separate database operations with no isolation.

Two customers add the last unit of a product to their carts. Both hit checkout at the same time. Both requests read `quantityOnHand = 10, quantityReserved = 9`. Both see 1 available. Both write `quantityReserved = 10`. Both succeed. But there was only one unit. One customer will never get their product.

This is not a load problem. This happens at two concurrent requests. For a flash sale or a limited drop, it is a certainty.

**What RFC-005 Part 2 changes for the engine:** `SELECT ... FOR UPDATE` makes the second request wait for the first to commit or rollback. The second request then reads the updated `quantityReserved = 10`, sees 0 available, and correctly fails. The engine becomes correct under concurrency.

**What this changes for the merchant:** They do not oversell. They do not have to email a customer saying "we charged you but the product is gone." They do not eat the cost of a refund plus a chargeback fee. For a small merchant, one incident like this is an annoyance. For a merchant running a flash sale of 500 units, this is a crisis.

### Bug 2: Checkout can leave the system in an inconsistent state

I verified in `packages/core/src/hooks/checkout.ts`. The AfterHooks are `capturePayment` (line 436-445), then `reserveInventory` (lines 447-466). They run in sequence. There is no compensation logic.

If `capturePayment` succeeds (the customer's card is charged) and then `reserveInventory` fails (a transient database error, a network hiccup), the system has charged the customer but not reserved inventory. The order exists. The payment exists. The inventory is not reflected. There is no automated path to fix this. A human must notice, investigate, and manually refund or manually adjust inventory.

**What RFC-005 Part 1 changes for the engine:** The compensation chain reverses completed steps when a later step fails. If `reserveInventory` runs first and then `capturePayment` fails, inventory is released. If both succeed, the checkout is consistent. The engine becomes self-healing for the most critical transaction it processes.

**What this changes for the merchant:** Their customer is never charged without a corresponding inventory reservation. The merchant does not wake up to a support queue of "I was charged but didn't get a confirmation." They do not need a dedicated operations person to reconcile checkout failures.

### The maintenance cost of structural repetition

I verified 15 repository files across the codebase. `CatalogRepository` (746 lines), `OrderRepository` (271 lines), `CustomerRepository` (317 lines), `CartRepository` (150+ lines) -- all containing structurally identical `findById`, `findMany`, `create`, `update`, `delete` methods. The same `getDb(ctx)` helper. The same WHERE clause building. The same `returning()` call. Over 2000 lines of copy-paste code.

This is not an aesthetic concern. It is a compounding cost. When the `null` vs `undefined` bug was found in inventory queries (documented in project memory), the fix had to be applied in multiple files. When soft-delete support is added, it must be added to every repository that needs it. When pagination semantics change, every `findMany` must be updated.

**What RFC-005 Part 3 changes for the engine:** One factory function, one fix location, one test surface. The 15 modules either use the factory directly or delegate standard CRUD to it and keep only domain-specific methods. The codebase shrinks by roughly 2000 lines.

**What this changes for the developer:** They add a new module by calling `createRepository(myTable, db)` instead of writing 200 lines of boilerplate. When the engine upgrades the factory with cursor pagination or improved soft-delete, every module gets it for free.

### No audit trail means no compliance

I searched the codebase. There is an `orderStatusHistory` table in the orders schema, but no centralized audit log. When an admin changes an order from `confirmed` to `cancelled`, there is a status history entry. But when inventory is adjusted, when a refund is issued, when a product is unpublished -- there is no record of who did it or when.

**What RFC-005 Part 8 changes for the merchant:** Every significant state change is recorded with who, when, and what. When a chargeback dispute arrives and the payment processor asks "can you show the timeline of this order?", the merchant can export the audit log. When an employee makes an unauthorized refund, the audit trail shows it. This is table stakes for any business that handles money.

---

## DX: Can I build what my client needs without forking?

The developer building on this engine has a client with specific requirements. Every place where the engine cannot be extended without forking is a place where the developer either: (a) forks and loses future upgrades, (b) implements it themselves and adds maintenance burden, or (c) tells the client "no."

### The developer cannot add a column to a core table

I verified in `packages/core/src/kernel/plugin/manifest.ts`. `defineCommercePlugin` returns a static manifest. RFC-002 explicitly states (Section 9.2): "Direct mutation of core table shape by plugins is disallowed." The required pattern is extension tables with foreign key joins.

Extension tables are correct for plugins (install/uninstall safety). But the application developer -- the person writing `commerce.config.ts` who owns the database -- also cannot add columns without forking. If the client says "I need a `supplierCode` field on every product," the developer's only option today is to fork the catalog module.

**What RFC-005 Part 9 changes:** `createCatalogModule({ extraColumns: (base) => ({ supplierCode: text("supplier_code") }) })`. The column is a real database column, indexed, typed, queryable. Drizzle's `$inferSelect` picks it up automatically. No fork. No extension table join overhead for a permanent schema change.

**What this changes for the merchant's business:** The developer delivers the feature faster. The merchant gets `supplierCode` on their product pages, in their admin, in their exports, without a custom integration layer. The developer can upgrade the engine without rebasing a fork.

### The developer cannot express "admins see everything, customers see only their own orders"

I verified in `packages/core/src/auth/permissions.ts`. It is 29 lines. Two functions: `assertPermission` (throws if the permission string is not in the actor's list) and `assertOwnership` (throws if `actor.userId !== resourceOwnerId`). Both are Boolean: allow or throw.

Today, implementing "admins see all orders, customers see only their own" requires custom code in the orders route handler. The route must check the actor's role, conditionally add a WHERE clause, and handle the fallback. This logic is duplicated in every route that has the same pattern.

**What RFC-005 Part 4 changes:** The developer writes:

```typescript
const orderReadAccess = accessOR(isAdmin, isDocumentOwner("customerId"))
```

This returns `true` for admins (no filter) or a `WhereClause` for customers (filter to their orders). The route passes the result to the service. One line. Composable. Testable. Reusable across every route with the same pattern.

**What this changes for the merchant's business:** The developer implements multi-role access correctly the first time. The merchant's staff sees all orders. The merchant's customers see only their own. The B2B buyer sees only their organization's orders. Each rule is one composed function, not a custom middleware chain that might have security holes.

### The developer cannot do background work from a hook

I verified: there is no `JobsAdapter`, no `enqueue`, no background job infrastructure in the codebase. The webhook delivery worker (`packages/core/src/modules/webhooks/worker.ts`) runs synchronously within the request.

A developer building an integration -- order confirmation emails, ERP sync, Algolia reindexing -- has two choices today: block the HTTP response (adding 200-500ms latency per integration) or fire-and-forget (unsafe in serverless -- the Lambda terminates before the work completes).

**What RFC-005 Part 6 changes:** `context.jobs.enqueue("sync-to-erp", { orderId })` inserts a row into the `commerce_jobs` table. The HTTP response returns immediately. A runner processes the job later. No Redis. No SQS. No external dependency. The developer's integration is reliable and non-blocking.

**What this changes for the merchant's business:** Checkout is fast. The confirmation email arrives. The ERP is synced. The search index is updated. None of these things add latency to the customer's purchase experience. The merchant does not get complaints about slow checkout. The merchant does not get "I never received a confirmation email" support tickets because the email send was silently dropped when a Lambda terminated.

### The developer cannot sell customizable products without forking the cart

I verified in `packages/core/src/modules/cart/service.ts`. The `addItem` method does not check for existing items with the same entity/variant combination. There is no deduplication logic at all -- and when deduplication is added, it will be hardcoded to `entityId + variantId`.

A developer building a store that sells engraved jewelry, custom-printed shirts, or configurable gift baskets needs cart deduplication that considers custom fields. "Same product, same variant, but different engraving text" should be two separate line items. Today there is no way to express this without rewriting the cart module.

**What RFC-005 Part 10 changes:** The developer passes a function:

```typescript
createCartModule({
  cartItemMatcher: ({ existingItem, newItem }) =>
    existingItem.entityId === newItem.productId &&
    existingItem.variantId === newItem.variantId &&
    existingItem.metadata?.engravingText === newItem.engravingText,
})
```

One function. The cart module calls it. The developer does not touch the cart internals.

**What this changes for the merchant's business:** The merchant can sell customizable products. The cart correctly shows "Necklace (engraved: 'Alice') x1" and "Necklace (engraved: 'Bob') x1" as separate items. The merchant does not lose revenue because the cart merged two different customizations into one line item with quantity 2.

### The developer cannot build a store that allows guest checkout

I verified: the cart schema has no `secret` column, no guest cart concept. Cart creation calls `assertPermission(actor, "cart:create")`, which throws if the actor is null. Anonymous users cannot create carts.

Every conversion rate study in ecommerce says the same thing: requiring account creation before checkout reduces conversion by 20-30%. This is not a feature -- it is a revenue impact.

**What RFC-005 Part 11 changes:** A guest creates a cart with `POST /api/carts/guest`, receives a `{ cartId, secret }`. They add items using the secret. When they decide to create an account, `mergeCarts(guestCartId, authenticatedCartId, secret)` moves items to their authenticated cart using the `CartItemMatcher` for deduplication.

**What this changes for the merchant's business:** The merchant's conversion rate improves. Customers who are "just browsing" can add items without friction. When they commit to purchasing, their cart is waiting. The merchant does not lose the 20-30% of customers who abandon at a forced registration wall.

---

## Business (The Merchant): The revenue and operations picture

Let me reframe the entire RFC from the merchant's perspective. The merchant does not know what a compensation chain is. They know what these things are:

| What the merchant experiences today | What they experience after RFC-005 |
|---|---|
| A customer is charged but inventory is not reserved. Manual fix required. | Checkout either fully succeeds or fully rolls back. No manual intervention. |
| Two customers buy the last unit during a flash sale. One must be refunded. | The second customer gets an "out of stock" error at checkout. Clean. |
| Checkout takes 2-3 seconds because email, ERP sync, and search indexing run inline. | Checkout takes 200ms. Background work happens asynchronously, reliably. |
| Guest customers must create an account to add items to cart. Many leave. | Guests add items freely. Cart persists. Account creation happens at checkout. |
| When a support ticket says "who changed this order?", there is no answer. | Every state change is logged with actor, timestamp, and payload. |
| The developer says "that feature will take 3 weeks because I need to fork the cart module." | The developer configures a function and ships in 2 days. |
| The developer says "I cannot add a supplier code to products without a major refactor." | The developer adds `extraColumns` to the config and ships in an hour. |

---

## The honest bottom line

RFC-001 promised a "serverless-first, AI-native headless commerce kernel" with "Developer Experience Above All" and "Composition Over Configuration." The current codebase delivers the architecture but not the production guarantees. It is a working prototype that processes happy-path transactions correctly.

RFC-005 turns that prototype into something you can point a real merchant at. Not because it adds features, but because it closes the gaps that would cause the merchant to lose money, the developer to lose time, and the engine to lose credibility.

The cost of not doing this work is not zero. It is the first oversold flash sale, the first checkout inconsistency at scale, the first developer who forks because they cannot extend a table, and the first enterprise prospect who asks "show me the audit trail" and gets silence.
