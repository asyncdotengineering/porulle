# RFC-019: Fashion Starter — Medusa-to-UnifiedCommerce Migration

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-17
- **Source:** [Agilo/fashion-starter](https://github.com/Agilo/fashion-starter) (Medusa 2.0 + Next.js 15)
- **Target:** `apps/fashion-starter/` in the UnifiedCommerce monorepo
- **Estimated effort:** 5-7 engineering-days
- **Priority:** High — this becomes the reference storefront demonstrating the full UnifiedCommerce stack

---

## 1. What This Is

The Agilo Fashion Starter is a production-grade Next.js 15 storefront themed as "Sofa Society" — a sustainable furniture brand selling sofas and armchairs. It features:

- Home page with hero image, product type showcase, collections carousel, and brand story section
- Collection pages with full-bleed hero images, collection description, and filtered product grid
- Store page with collection slider, refinement filters (collection, category, type), sort controls, and infinite scroll pagination
- Product detail pages with image gallery (Embla carousel), material-then-color variant selection with dynamic pricing, collection cross-sell with lifestyle imagery, and related products
- Cart page with line item management (quantity adjustment, removal), subtotal/shipping/tax breakdown
- Five-step checkout: email, delivery details, shipping method, payment (Stripe/PayPal), review
- Customer account portal: login, register, password reset, order history, order detail
- Inspiration page (editorial content)
- About page (brand story)
- Search with Meilisearch integration
- Responsive across mobile, tablet, desktop

The design is minimalist, high-end, and image-heavy — concrete textures, neutral palettes, generous whitespace. The Figma source file is publicly available.

---

## 2. Surgical Migration Strategy

The migration removes Medusa entirely and replaces it with UnifiedCommerce served from within the same Next.js process via the Hono-to-Next.js integration pattern established in RFC (deployment docs). The storefront React components, Tailwind styles, static images, and page structure remain untouched. Only the data-fetching layer and API contract change.

### What Gets Deleted

- The entire `medusa/` directory (backend, admin UI, custom modules, config)
- All `@medusajs/*` imports in the storefront
- The Medusa JS SDK initialization (`storefront/src/lib/config.ts`)
- All data-fetching functions in `storefront/src/lib/data/` that call Medusa endpoints
- The custom Fashion module (materials/colors) — replaced by UnifiedCommerce's `option_types` + `option_values`

### What Gets Kept

- The entire `storefront/src/app/` page structure (routes, layouts, metadata)
- All React components in `storefront/src/modules/` (header, cart, checkout, products, collections, account, order, auth, common, skeletons, store)
- All Tailwind CSS configuration and styles
- All static images in `storefront/public/images/`
- The Embla carousel, React Hook Form, Zod validation infrastructure
- The responsive layout and design system

### What Gets Replaced

| Medusa Layer | UnifiedCommerce Replacement |
|-------------|---------------------------|
| `@medusajs/js-sdk` (Medusa SDK) | `@unifiedcommerce/sdk` (`createSDK` + `createCommerceHooks`) |
| `sdk.client.fetch('/store/products', ...)` | `sdk.catalog.list()` / `sdk.catalog.get()` |
| `sdk.store.cart.create(...)` | `sdk.cart.create()` / `sdk.cart.addItem()` |
| `sdk.store.auth.authenticate(...)` | Better Auth session via `/api/auth/*` routes |
| Medusa regions (country-to-currency mapping) | UnifiedCommerce config `entities` + pricing per currency |
| Medusa workflows (seed, product creation) | Direct service calls via kernel or REST API |
| Custom Fashion module (Material/Color models) | `option_types` ("Material") + `option_values` ("Velvet", "Linen") + `variant_option_values` |
| Meilisearch module | `@unifiedcommerce/adapter-pg-search` (or keep Meilisearch via `adapter-meilisearch`) |
| Resend module | `@unifiedcommerce/adapter-resend` (already built) |
| Stripe payment module | `@unifiedcommerce/adapter-stripe` (already built) |

---

## 3. Data Model Mapping

### Products (10 sofas/armchairs)

Medusa's product model maps directly to UnifiedCommerce's `sellable_entities`:

| Medusa Field | UC Field | Notes |
|-------------|----------|-------|
| `handle` | `slug` | URL path segment |
| `title` | `attributes.title` | Via `sellable_attributes` table |
| `description` | `attributes.description` | Via `sellable_attributes` table |
| `thumbnail` | Media attachment | Via `media_assets` + `entity_media` |
| `images[]` | Media attachments | Multiple images per entity |
| `status` (published/draft) | `status` (active/draft/archived) | |
| `type` (Sofas/Arm Chairs) | Entity `type` field in config | Maps to `entities.sofa` / `entities.armchair` |
| `categories[]` | `entity_categories` join | One Seater, Two Seater, Three Seater |
| `collection` | Collection metadata or category | 4 collections as categories with rich metadata |

### Variants (Material + Color combinations)

Medusa's variant model with the custom Fashion module maps to UnifiedCommerce's `option_types` + `option_values` + `variant_option_values`:

```
Medusa:
  Product → Variant (title: "Microfiber / Dark Gray", sku: "ASTRID-CURVE-MICROFIBER-DARK-GRAY")
  Fashion Module → Material (name: "Microfiber") → Color (name: "Dark Gray", hex: "#4A4A4A")

UnifiedCommerce:
  sellable_entity → option_type (name: "Material")
                  → option_type (name: "Color")
  option_type "Material" → option_value "Microfiber"
  option_type "Color" → option_value "Dark Gray" (metadata: { hex: "#4A4A4A" })
  variant → variant_option_values → [option_value "Microfiber", option_value "Dark Gray"]
  price → prices (entity_id, variant_id, currency: "EUR", amount: 150000)
```

The Fashion module's Material-then-Color selection UI does not need a custom module in UnifiedCommerce. It is handled by the standard `option_types` system with the UI fetching option types and rendering them as cascading dropdowns. The `hex_code` lives in `option_values.metadata.hex`.

### Collections (4)

Medusa collections have rich metadata (title, description, multiple images for different page contexts). In UnifiedCommerce, collections map to categories with metadata:

```
category:
  slug: "scandinavian-simplicity"
  metadata: {
    title: "Scandinavian Simplicity"
    subtitle: "Effortless elegance, timeless comfort"
    description: "Minimalistic designs, neutral colors..."
    images: {
      hero: "https://cdn.../scandinavian-hero.jpg"
      collection_page: "https://cdn.../scandinavian-collection.jpg"
      product_page: "https://cdn.../scandinavian-product.jpg"
      cta: "https://cdn.../scandinavian-cta.jpg"
    }
  }
```

### Pricing

Medusa uses region-based pricing (EUR for Europe, USD for US). UnifiedCommerce uses the `prices` table with `currency` field:

```
prices:
  - entity_id: <astrid-curve>, variant_id: <microfiber-dark-gray>, currency: "EUR", amount: 150000
  - entity_id: <astrid-curve>, variant_id: <microfiber-dark-gray>, currency: "USD", amount: 170000
```

---

## 4. Architecture: Next.js + UnifiedCommerce In-Process

The storefront runs as a Next.js App Router application. UnifiedCommerce is embedded in the same process via the catch-all API route pattern:

```
apps/fashion-starter/
  app/
    api/[[...route]]/route.ts       -- Hono app mounted here
    [countryCode]/                   -- all storefront pages (kept from Medusa starter)
      (main)/
        page.tsx                     -- home
        products/[handle]/page.tsx   -- product detail
        collections/[handle]/page.tsx -- collection
        store/page.tsx               -- product grid
        cart/page.tsx                -- cart
        about/page.tsx               -- about
        inspiration/page.tsx         -- inspiration
        search/page.tsx              -- search
        account/page.tsx             -- customer portal
      (checkout)/
        checkout/page.tsx            -- checkout flow
  src/
    lib/
      commerce.ts                    -- createSDK({ baseUrl: "/api" })
      data/                          -- rewritten data-fetching functions using SDK
    modules/                         -- kept from Medusa starter (React components)
  commerce.config.ts                 -- UnifiedCommerce config with plugins
  public/images/                     -- kept static assets
```

The `api/[[...route]]/route.ts` file:

```typescript
import { handle } from "hono/vercel";
import { createServer } from "@unifiedcommerce/core";
import config from "../../commerce.config";

const { app } = createServer(await config);

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
```

The data-fetching layer (`src/lib/data/`) calls the SDK which hits `/api/*` -- resolved in-process by Hono, no network hop.

---

## 5. Seed Script

The Medusa seed script (`medusa/src/scripts/seed.ts`) creates 10 products, 4 collections, 5 materials, 15 colors, 3 categories, 2 product types, and ~150 product images hosted on the Agilo CDN. The UnifiedCommerce seed script will replicate this data using the kernel's service layer:

```typescript
// apps/fashion-starter/src/scripts/seed.ts
import { createKernel } from "@unifiedcommerce/core";
import config from "../../commerce.config";

const kernel = createKernel(await config);
const actor = { type: "user", userId: "seed", role: "admin", permissions: ["*:*"], ... };

// 1. Create categories (collections)
const scandinavian = await kernel.services.catalog.createCategory(
  { slug: "scandinavian-simplicity", metadata: { title: "Scandinavian Simplicity", images: { ... } } },
  actor,
);

// 2. Create brands (product types as brands)
const sofas = await kernel.services.catalog.createBrand(
  { slug: "sofas", displayName: "Sofas", metadata: { image: "https://cdn.../sofas.jpg" } },
  actor,
);

// 3. Create products with attributes
const astridCurve = await kernel.services.catalog.create(
  { type: "product", slug: "astrid-curve", metadata: { ... } },
  actor,
);
await kernel.services.catalog.setAttributes(astridCurve.value.id, "en", {
  title: "Astrid Curve",
  description: "A three seater sofa from the Boho Chic collection...",
}, actor);

// 4. Create option types + values
await kernel.services.catalog.createOptionType(astridCurve.value.id, {
  entityId: astridCurve.value.id,
  name: "material",
  displayName: "Material",
}, actor);
// ... option values with hex metadata

// 5. Create variants with option value linkage
await kernel.services.catalog.createVariant(astridCurve.value.id, {
  entityId: astridCurve.value.id,
  sku: "ASTRID-CURVE-MICROFIBER-DARK-GRAY",
  optionValueIds: [microfiberValueId, darkGrayValueId],
}, actor);

// 6. Set prices per variant per currency
await kernel.services.pricing.setBasePrice({
  entityId: astridCurve.value.id,
  variantId: variant.id,
  currency: "EUR",
  amount: 150000,
});

// 7. Upload product images (reference Agilo CDN URLs, store via media service)
// 8. Create warehouse + adjust inventory
// 9. Create promotions
```

---

## 6. Data-Fetching Layer Rewrite

Each file in `storefront/src/lib/data/` is rewritten to use the UnifiedCommerce SDK:

| File | Medusa SDK Call | UnifiedCommerce SDK Call |
|------|---------------|------------------------|
| `products.ts` | `sdk.client.fetch('/store/products', ...)` | `sdk.catalog.list({ type: "product" })` |
| `products.ts` | `getProductByHandle(handle, regionId)` | `sdk.catalog.get(handle)` |
| `collections.ts` | `sdk.client.fetch('/store/collections', ...)` | `sdk.catalog.listCategories()` (collections are categories) |
| `cart.ts` | `sdk.store.cart.create({region_id})` | `sdk.cart.create({ currency: "EUR" })` |
| `cart.ts` | `sdk.store.cart.addLineItem(cartId, {variant_id, quantity})` | `sdk.cart.addItem(cartId, { entityId, variantId, quantity })` |
| `customer.ts` | `sdk.store.auth.authenticate("email", {...})` | Better Auth: `POST /api/auth/sign-in` |
| `regions.ts` | `sdk.client.fetch('/store/regions')` | Static config (no region concept — currency in config) |
| `orders.ts` | `sdk.store.order.retrieve(id)` | `sdk.me.orders.get(id)` |
| `payment.ts` | `sdk.store.payment.initiatePaymentSession(...)` | `sdk.checkout.create(...)` (Stripe handled server-side) |
| `categories.ts` | `sdk.client.fetch('/store/product-categories', ...)` | `sdk.catalog.listCategories()` |

### Fashion Data (Material/Color) Endpoint

The Medusa Fashion module exposes `GET /store/custom/fashion/[productHandle]` returning materials with colors per product. In UnifiedCommerce, this data is already available on the product entity via `option_types` and `option_values`. The product detail page fetches the product (which includes its option types and values in the `include=options,variants` query param) and renders the cascading Material -> Color dropdowns from the standard schema.

No custom API endpoint needed. The existing `sdk.catalog.get(handle, { include: "options,variants,attributes" })` returns everything.

---

## 7. Implementation Phases

### Phase 1: Scaffold (Day 1)

- [ ] Create `apps/fashion-starter/` in the monorepo
- [ ] Copy `storefront/` contents (pages, modules, styles, public assets, config)
- [ ] Delete all `@medusajs/*` imports and dependencies
- [ ] Add `@unifiedcommerce/core`, `@unifiedcommerce/sdk`, `@unifiedcommerce/adapter-postgres`, `@unifiedcommerce/adapter-stripe`, `@unifiedcommerce/adapter-resend`
- [ ] Create `commerce.config.ts` with entity definitions, auth config, Stripe adapter
- [ ] Create `app/api/[[...route]]/route.ts` mounting the Hono app
- [ ] Create `src/lib/commerce.ts` initializing the SDK with `baseUrl: "/api"`
- [ ] Verify Next.js builds (no Medusa imports, no runtime errors)

### Phase 2: Data Layer (Day 2-3)

- [ ] Rewrite `src/lib/data/products.ts` — list, get by handle, get by ID
- [ ] Rewrite `src/lib/data/collections.ts` — list, get by handle (via categories)
- [ ] Rewrite `src/lib/data/cart.ts` — create, get, add item, update item, remove item
- [ ] Rewrite `src/lib/data/customer.ts` — auth, profile, addresses (via Better Auth)
- [ ] Rewrite `src/lib/data/orders.ts` — list, get by ID
- [ ] Rewrite `src/lib/data/categories.ts` — list (One Seater, Two Seater, Three Seater)
- [ ] Rewrite `src/lib/data/regions.ts` — static config (no Medusa regions)
- [ ] Rewrite `src/lib/data/payment.ts` — Stripe payment intent via checkout
- [ ] Replace `src/lib/data/product-types.ts` — use brands or entity type config
- [ ] Delete `src/lib/data/product-fashion.ts` — no custom endpoint needed

### Phase 3: Seed + Verify (Day 4)

- [ ] Write `src/scripts/seed.ts` porting all 10 products, 4 collections, variants, prices, images
- [ ] Run seed against local PostgreSQL
- [ ] Verify home page renders (product types, collections, about section)
- [ ] Verify store page renders (product grid, filters, sort, pagination)
- [ ] Verify collection pages render (hero, description, filtered products)
- [ ] Verify product detail page renders (gallery, material/color selection, pricing, related)
- [ ] Verify cart page renders (add items, update quantity, totals)

### Phase 4: Checkout + Auth (Day 5-6)

- [ ] Wire checkout flow to UnifiedCommerce checkout API
- [ ] Wire Stripe payment integration
- [ ] Wire Better Auth for customer login/register/password-reset
- [ ] Wire customer account portal (order history, order detail)
- [ ] Test end-to-end: browse, add to cart, checkout with Stripe test card, order confirmation

### Phase 5: Polish (Day 7)

- [ ] Search integration (pg-search or Meilisearch adapter)
- [ ] Email notifications (order confirmation via Resend adapter)
- [ ] Responsive testing (mobile, tablet, desktop)
- [ ] Image optimization (next/image remote patterns for product images)
- [ ] SEO metadata (generateMetadata for product/collection pages)
- [ ] Error pages (404, error boundaries)
- [ ] Update README with UnifiedCommerce setup instructions

---

## 8. What This Proves

The migrated fashion starter demonstrates that UnifiedCommerce can:

1. Power a production-grade Next.js storefront with zero Medusa dependency
2. Run embedded in the same Next.js process (no separate backend server)
3. Handle complex variant selection (Material -> Color cascading)
4. Process real payments via Stripe
5. Manage customer accounts via Better Auth
6. Send transactional emails via Resend
7. Serve product images via S3/local storage
8. Support multi-currency pricing (EUR, USD)
9. Support filtered product browsing with sort and pagination
10. Support search (full-text via PostgreSQL or Meilisearch)

It becomes the canonical "look at what you can build" reference for every developer evaluating the platform.

---

## 9. Success Criteria

- [ ] `bun run dev` starts the fashion storefront on localhost:3000
- [ ] Home page renders with product types, collections, and about section
- [ ] Store page renders with 10+ products, working filters and sort
- [ ] Product page renders with image gallery, material/color selection, dynamic pricing
- [ ] Cart flow works end-to-end (add, update quantity, remove)
- [ ] Checkout flow completes with Stripe test card
- [ ] Order confirmation page shows correct order details
- [ ] Customer can register, login, view order history
- [ ] Search returns relevant products
- [ ] All pages are responsive (mobile, tablet, desktop)
- [ ] No `@medusajs/*` imports remain in the codebase
- [ ] Zero Medusa backend processes running — everything in-process via Next.js

---

## 10. References

- Source repository: [Agilo/fashion-starter](https://github.com/Agilo/fashion-starter)
- Figma design: [Community file](https://www.figma.com/community/file/1494273775050024009)
- Cloned to: `about-fashion-starter/` (reference, not deployed)
- Hono + Next.js integration: [hono.dev/docs/getting-started/nextjs](https://hono.dev/docs/getting-started/nextjs)
- Product images hosted on: `fashion-starter-demo.s3.eu-central-1.amazonaws.com`
