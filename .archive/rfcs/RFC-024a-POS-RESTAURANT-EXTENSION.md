# RFC-024a: POS Restaurant Extension — Detailed Design

- **Status:** Accepted
- **Author:** Engineering
- **Date:** 2026-03-19
- **Depends on:** RFC-023 (POS Tier 0 Core Primitives)
- **Scope:** `packages/plugins/plugin-pos-restaurant/` (new plugin)
- **Informed by:** URY Restaurant ERP (production system serving 10+ outlets)
- **Estimated effort:** 7-10 engineering-days

---

## 0. URY Research Summary

The URY ERP (github.com/ury-erp/ury) is an open-source restaurant management system built on ERPNext/Frappe, running at scale across 10+ outlets. This RFC is informed by deep analysis of URY's production architecture:

**What URY does well (adopted in this RFC):**

| URY Pattern | Our Adaptation |
|------------|----------------|
| URY Table: room-based organization, occupied/available status, floor plan layout (layout_x/y), shape (Circle/Square/Rectangle), seat capacity, is_take_away flag | `pos_tables` with zone, capacity, shape, layout coordinates, status state machine |
| URY Production Unit: item-group-based routing, per-station printers | `kds_stations` with item group routing, configurable per station |
| URY KOT: submittable ticket per production unit, type enum (New Order/Order Modified/Cancelled/Partially cancelled), order_status (Ready For Prepare -> Served), production_time tracking | `kds_tickets` with status state machine, timing metrics, station routing |
| URY Menu Course: custom_serving_priority for course sequencing, custom_indicate_in_kds for display labeling | `courseNumber` on ticket items, sorted display on KDS |
| Socket.IO real-time broadcasting: channel per branch+production, audio alerts, cache-based deduplication | SSE/WebSocket push to KDS clients per station |
| Multi-printer routing: production unit printers > room printers > POS printers, with takeaway blocking | Printer config on stations with routing rules |
| Table transfer (same room only), captain transfer, table status lifecycle | Table transfer + server reassignment APIs |
| Order types: Dine In, Take Away, Delivery, Phone In, Aggregators | `orderType` on transactions with type-specific routing |

**Where URY falls short (improved in this RFC):**

| URY Limitation | Our Improvement |
|---------------|-----------------|
| Item Add On is a flat item link with no grouping, no required/optional, no min/max, no modifier pricing | Full modifier group system: `pos_modifier_groups` with isRequired, minSelect, maxSelect; `pos_modifier_options` with priceAdjustment |
| No bill splitting | Not in Tier 1 scope (deferred) |
| No tip handling | `tipAmount` on payments, tip reporting in Z-report |
| KOT item strikethrough stored only in browser localStorage, not persisted | `kds_ticket_items.status` persisted to DB |
| No structured course firing — kitchen manually reads priority order | Explicit course sequencing with `courseNumber` on ticket items |
| Table status is binary (occupied=0/1) | Four-state machine: available -> occupied -> bill_requested -> cleaning |
| No table merge (combine 2 tables for large party) | Table merge API |

---

## 1. Design Principles

### 1.1 Layered on Tier 0

This plugin extends `@unifiedcommerce/plugin-pos` (RFC-023). It does NOT replace any Tier 0 functionality. A restaurant installs both:

```typescript
plugins: [
  posPlugin(),
  posRestaurantPlugin({ enableKDS: true, enableTips: true }),
]
```

The restaurant plugin adds schema, routes, and hooks. It reads from Tier 0 tables (`pos_transactions`, `pos_payments`, `pos_shifts`) but does not modify them. It adds new columns to Tier 0 tables via hooks and metadata, not schema changes.

### 1.2 Modifier-First Design

URY's biggest gap is modifier support. Every restaurant needs: "Choose your protein" (required, pick 1), "Add toppings" (optional, pick 0-5, each priced), "How would you like it cooked?" (required, pick 1, no price change). This plugin makes modifiers a first-class concept with validation at the cart layer.

### 1.3 KDS as a Ticket Queue, Not a Live Feed

URY broadcasts KOTs via Socket.IO and the KDS is a passive receiver. Our design treats KDS as a **ticket queue** with persistent state. Each ticket has a status machine (pending -> preparing -> ready -> served), timing metrics, and item-level completion tracking stored in the database, not browser localStorage.

---

## 2. Data Model

### 2.1 Modifier Tables

**Table: `pos_modifier_groups`**

Defines a set of choices for a menu item. Linked to a catalog entity (product) or item group (category-wide).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `organization_id` | text | NOT NULL | |
| `name` | text | NOT NULL | Display name ("Choose your protein", "Add toppings") |
| `entity_id` | uuid | FK to sellable_entities | Item this group applies to. NULL if category-wide. |
| `item_group` | text | | Category slug. If set, applies to all items in this category. |
| `is_required` | boolean | NOT NULL, default false | Must the customer make a selection? |
| `min_select` | integer | NOT NULL, default 0 | Minimum options to select (0 = optional) |
| `max_select` | integer | NOT NULL, default 1 | Maximum options to select (1 = radio, N = multi-select) |
| `sort_order` | integer | NOT NULL, default 0 | Display order among groups for the same item |
| `created_at` | timestamptz | NOT NULL | |
| `updated_at` | timestamptz | NOT NULL | |

Composite unique: `(organization_id, name, entity_id)`.

**Table: `pos_modifier_options`**

Individual options within a group.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `group_id` | uuid | NOT NULL, FK to pos_modifier_groups | |
| `name` | text | NOT NULL | Display name ("Extra cheese", "No onions") |
| `price_adjustment` | integer | NOT NULL, default 0 | Price delta in cents. Positive = surcharge. Negative = discount. Zero = no charge. |
| `is_default` | boolean | NOT NULL, default false | Pre-selected in UI |
| `is_available` | boolean | NOT NULL, default true | Can be temporarily unavailable (86'd) |
| `sort_order` | integer | NOT NULL, default 0 | Display order within the group |
| `created_at` | timestamptz | NOT NULL | |

### 2.2 Table Management Tables

**Table: `pos_tables`**

Represents a physical table or virtual station (takeaway counter, bar seat).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `organization_id` | text | NOT NULL | |
| `number` | text | NOT NULL | Display label ("T1", "Bar-3", "Patio-12") |
| `zone` | text | NOT NULL | Room/area ("Main Hall", "Patio", "Private Dining") |
| `capacity` | integer | NOT NULL, default 4 | Maximum seats |
| `minimum_seats` | integer | NOT NULL, default 1 | Minimum party size |
| `shape` | text | NOT NULL, default 'rectangle' | Enum: rectangle, square, circle |
| `status` | text | NOT NULL, default 'available' | Enum: available, occupied, bill_requested, cleaning |
| `is_takeaway` | boolean | NOT NULL, default false | Virtual table for takeaway orders |
| `assigned_operator_id` | text | | Server assigned to this table (Better Auth user ID) |
| `layout_x` | integer | default 0 | Floor plan X position (pixels) |
| `layout_y` | integer | default 0 | Floor plan Y position (pixels) |
| `layout_width` | integer | default 100 | Floor plan width |
| `layout_height` | integer | default 100 | Floor plan height |
| `metadata` | jsonb | default {} | |
| `created_at` | timestamptz | NOT NULL | |
| `updated_at` | timestamptz | NOT NULL | |

Composite unique: `(organization_id, number)`.

**Table: `pos_table_assignments`**

Links tables to active POS transactions. Supports multi-table seating (large party across 2+ tables).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `table_id` | uuid | NOT NULL, FK to pos_tables | |
| `transaction_id` | uuid | NOT NULL, FK to pos_transactions | |
| `seated_at` | timestamptz | NOT NULL | When the party was seated |
| `created_at` | timestamptz | NOT NULL | |

### 2.3 KDS Tables

**Table: `kds_stations`**

Represents a kitchen station/section. URY calls this "URY Production Unit". Each station displays its own KDS feed and has its own printer routing.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `organization_id` | text | NOT NULL | |
| `name` | text | NOT NULL | Display name ("Grill Station", "Pastry", "Bar") |
| `is_active` | boolean | NOT NULL, default true | |
| `alert_threshold_minutes` | integer | NOT NULL, default 15 | Minutes before ticket turns red on KDS |
| `metadata` | jsonb | default {} | Printer config, audio alert settings |
| `created_at` | timestamptz | NOT NULL | |
| `updated_at` | timestamptz | NOT NULL | |

Composite unique: `(organization_id, name)`.

**Table: `kds_station_item_groups`**

Maps item groups (categories) to stations for routing. URY equivalent: "URY Production Item Groups".

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `station_id` | uuid | NOT NULL, FK to kds_stations | |
| `item_group` | text | NOT NULL | Category slug (e.g., "mains", "desserts", "beverages") |
| `created_at` | timestamptz | NOT NULL | |

**Table: `kds_tickets`**

A kitchen ticket routed to a specific station. One POS transaction may generate multiple tickets (one per station). URY equivalent: "URY KOT".

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `organization_id` | text | NOT NULL | |
| `transaction_id` | uuid | NOT NULL, FK to pos_transactions | |
| `station_id` | uuid | NOT NULL, FK to kds_stations | |
| `order_id` | uuid | FK to orders | Set after checkout |
| `type` | text | NOT NULL, default 'new_order' | Enum: new_order, modified, cancelled, partially_cancelled |
| `status` | text | NOT NULL, default 'pending' | Enum: pending, preparing, ready, served |
| `table_number` | text | | Denormalized from pos_tables for KDS display |
| `order_type` | text | NOT NULL, default 'dine_in' | Enum: dine_in, takeaway, delivery |
| `operator_name` | text | | Server/waiter name for display |
| `ticket_number` | text | NOT NULL | Sequential per station per day |
| `fired_at` | timestamptz | | When kitchen started preparing |
| `ready_at` | timestamptz | | When marked ready |
| `served_at` | timestamptz | | When marked served |
| `prep_duration_seconds` | integer | | ready_at - fired_at |
| `comments` | text | | Order-level special instructions |
| `metadata` | jsonb | default {} | |
| `created_at` | timestamptz | NOT NULL | |
| `updated_at` | timestamptz | NOT NULL | |

Indexes: `(organization_id, station_id, status)`, `transaction_id`.

**Table: `kds_ticket_items`**

Individual items within a ticket. Includes course info for sequencing and modifier details.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `ticket_id` | uuid | NOT NULL, FK to kds_tickets | |
| `entity_id` | uuid | NOT NULL | Catalog entity ID |
| `variant_id` | uuid | | |
| `item_name` | text | NOT NULL | Denormalized for KDS display |
| `quantity` | integer | NOT NULL | |
| `cancelled_quantity` | integer | NOT NULL, default 0 | For partial cancellation tickets |
| `course_name` | text | | e.g., "Starters", "Mains" |
| `course_priority` | integer | NOT NULL, default 0 | Lower = fire first (URY: custom_serving_priority) |
| `show_course_label` | boolean | NOT NULL, default false | Display course name on KDS (URY: custom_indicate_in_kds) |
| `status` | text | NOT NULL, default 'pending' | Enum: pending, preparing, done |
| `modifiers` | jsonb | default [] | Array of { name, priceAdjustment } |
| `notes` | text | | Item-level special instructions |
| `created_at` | timestamptz | NOT NULL | |

---

## 3. API Design

### 3.1 Modifier Management

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/pos/restaurant/modifier-groups` | `pos-restaurant:admin` | Create modifier group |
| `GET` | `/api/pos/restaurant/modifier-groups` | `pos:operate` | List modifier groups (optionally filter by entityId) |
| `GET` | `/api/pos/restaurant/modifier-groups/{id}` | `pos:operate` | Get group with options |
| `PATCH` | `/api/pos/restaurant/modifier-groups/{id}` | `pos-restaurant:admin` | Update group |
| `DELETE` | `/api/pos/restaurant/modifier-groups/{id}` | `pos-restaurant:admin` | Delete group |
| `POST` | `/api/pos/restaurant/modifier-groups/{id}/options` | `pos-restaurant:admin` | Add option to group |
| `PATCH` | `/api/pos/restaurant/modifier-options/{id}` | `pos-restaurant:admin` | Update option |
| `DELETE` | `/api/pos/restaurant/modifier-options/{id}` | `pos-restaurant:admin` | Delete option |

### 3.2 Table Management

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/pos/restaurant/tables` | `pos-restaurant:admin` | Create table |
| `GET` | `/api/pos/restaurant/tables` | `pos:operate` | List tables (with status, zone filter) |
| `PATCH` | `/api/pos/restaurant/tables/{id}` | `pos-restaurant:admin` | Update table properties |
| `POST` | `/api/pos/restaurant/tables/{id}/assign` | `pos:operate` | Assign table to a POS transaction |
| `POST` | `/api/pos/restaurant/tables/{id}/clear` | `pos:operate` | Clear table (set available) |
| `POST` | `/api/pos/restaurant/tables/{id}/transfer` | `pos:operate` | Transfer transaction to another table |
| `PATCH` | `/api/pos/restaurant/tables/{id}/layout` | `pos-restaurant:admin` | Update floor plan position |
| `GET` | `/api/pos/restaurant/tables/zones` | `pos:operate` | List distinct zones with table counts |

### 3.3 KDS

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/pos/restaurant/kds/stations` | `pos-restaurant:admin` | Create station |
| `GET` | `/api/pos/restaurant/kds/stations` | `pos:operate` | List stations |
| `PATCH` | `/api/pos/restaurant/kds/stations/{id}` | `pos-restaurant:admin` | Update station |
| `POST` | `/api/pos/restaurant/kds/stations/{id}/item-groups` | `pos-restaurant:admin` | Add item group to station |
| `DELETE` | `/api/pos/restaurant/kds/stations/{id}/item-groups/{group}` | `pos-restaurant:admin` | Remove item group |
| `GET` | `/api/pos/restaurant/kds/stations/{id}/tickets` | `pos:operate` | List pending tickets for station |
| `POST` | `/api/pos/restaurant/kds/tickets/{id}/start` | `pos:operate` | Mark ticket as "preparing" |
| `POST` | `/api/pos/restaurant/kds/tickets/{id}/ready` | `pos:operate` | Mark ticket as "ready" |
| `POST` | `/api/pos/restaurant/kds/tickets/{id}/serve` | `pos:operate` | Mark ticket as "served" |
| `POST` | `/api/pos/restaurant/kds/tickets/{id}/items/{itemId}/done` | `pos:operate` | Mark individual item done |

### 3.4 Order Type

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `PATCH` | `/api/pos/restaurant/transactions/{id}/order-type` | `pos:operate` | Set order type (dine_in, takeaway, delivery) |

### 3.5 Tips

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/pos/restaurant/transactions/{id}/tip` | `pos:operate` | Add tip to transaction |

---

## 4. Hooks

### 4.1 `cart.beforeAddItem` — Modifier Validation

When an item is added to a POS cart, validate that all required modifier groups have selections within min/max bounds. This mirrors URY's approach but with structured validation instead of free-text comments.

```
IF item has modifier groups with isRequired=true:
  FOR EACH required group:
    IF selections.length < group.minSelect:
      THROW "Required: select at least {minSelect} from '{groupName}'"
    IF selections.length > group.maxSelect:
      THROW "Maximum {maxSelect} selections allowed for '{groupName}'"

  Sum modifier price adjustments into line item metadata.
```

### 4.2 `pos.transaction.afterCreate` — KDS Ticket Generation

When a POS transaction has items added, generate KDS tickets routed to the correct stations based on item group mapping. This mirrors URY's `kot_execute()` logic:

```
FOR EACH KDS station:
  Filter transaction items where item.entityType matches station.itemGroups
  IF matching items exist:
    Check if ticket already exists for this transaction+station
    IF exists: type = "modified"
    ELSE: type = "new_order"
    Create kds_ticket with matching items
```

### 4.3 `pos.transaction.afterComplete` — Table Status Update

When a transaction completes, update linked table status to "bill_requested" then "available".

### 4.4 `pos.transaction.afterVoid` — Table Clear

When a transaction is voided, clear the table assignment and set status to "available".

---

## 5. Permission Scopes

| Scope | Who Has It | What It Allows |
|-------|-----------|----------------|
| `pos-restaurant:admin` | Owner, Manager | Create/edit modifier groups, tables, KDS stations, floor plan |
| `pos:operate` | Cashier, Server, Manager | Inherited from Tier 0. Used for table assignment, KDS ticket status, tips |
| `pos:manage` | Manager | Inherited from Tier 0. Used for table transfers, voiding |

---

## 6. File Structure

```
packages/plugins/plugin-pos-restaurant/
  package.json
  tsconfig.json
  src/
    index.ts                          -- defineCommercePlugin entry
    schema.ts                         -- 8 Drizzle tables
    types.ts                          -- shared TypeScript types
    services/
      modifier-service.ts             -- modifier group + option CRUD, validation
      table-service.ts                -- table CRUD, status management, assignment, transfer
      kds-service.ts                  -- station CRUD, ticket generation, status updates
    routes/
      modifiers.ts                    -- modifier CRUD routes
      tables.ts                       -- table management routes
      kds.ts                          -- KDS station + ticket routes
      order-type.ts                   -- order type + tip routes
    hooks/
      modifier-validation.ts          -- cart.beforeAddItem hook
      kds-ticket-generation.ts        -- transaction item hooks
      table-lifecycle.ts              -- transaction complete/void hooks
  test/
    test-utils.ts                     -- test actors
    modifiers.test.ts                 -- modifier CRUD + validation
    tables.test.ts                    -- table lifecycle + transfer
    kds.test.ts                       -- ticket generation + status flow
    integration.test.ts               -- full flow: seat -> order -> KDS -> serve -> pay
```

---

## 7. Verification Checklist

1. `npx tsc --noEmit` -- zero errors in plugin
2. Modifier: create group with 3 options, required=true, minSelect=1, maxSelect=2. Add item without modifiers -> validation error. Add with 1 modifier -> succeeds. Add with 3 -> validation error.
3. Table: create 5 tables across 2 zones. Assign table to transaction -> status=occupied. Complete transaction -> status=available. Transfer between tables in same zone.
4. KDS: create 2 stations with different item groups. Add items spanning both stations -> 2 tickets generated. Mark items done -> ticket status transitions.
5. Course: items with course_priority 1 appear before course_priority 2 in ticket items.
6. Order type: set transaction to takeaway -> ticket.order_type updates.
7. Tips: add tip to payment -> appears in receipt and Z-report.
8. Multi-org: station in org A cannot see tickets from org B.

---

## 8. Configuration Options

```typescript
posRestaurantPlugin({
  enableKDS: true,            // Enable kitchen display system (default: true)
  enableTips: true,           // Enable tip collection (default: true)
  enableModifiers: true,      // Enable item modifiers (default: true)
  tableStatusFlow: ["available", "occupied", "bill_requested", "cleaning"],
  kdsAlertMinutes: 15,        // Minutes before KDS ticket turns red (default: 15)
})
```
