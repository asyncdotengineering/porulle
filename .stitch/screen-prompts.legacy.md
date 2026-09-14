# UnifiedCommerce Admin — Enhanced Stitch Screen Prompts

All prompts are structured with the DESIGN SYSTEM block and numbered page sections.
Design system applied via Stitch MCP (asset: `assets/9278609864119890931`).
Project: `projects/13611457616282475005`.

---

## Screen 1: Login — Authenticate into the admin

A focused, minimal login screen for a professional ecommerce admin dashboard. Dark theme with high-contrast accents on deep backgrounds, inspired by Linear and Stripe. Desktop web application for merchants who manage daily commerce operations.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, data-dense, zero decorative waste
- Font: Inter, variable weight
- Background: Void Black (#09090B) — full-page canvas
- Surface: Onyx Surface (#0F0F12) — login card background
- Border: Charcoal Border (#1F1F23) — card edge, input borders
- Input Fill: Graphite Muted (#27272A) — text field backgrounds
- Primary Accent: Electric Indigo (#6366F1) — submit button, focus rings
- Primary Hover: Soft Indigo (#4F46E5) — button hover state
- Text Primary: Pure White (#FAFAFA) — wordmark, heading
- Text Secondary: Slate Text (#A1A1AA) — subtitle, placeholder, links
- Error: Rose Error (#EF4444) — validation error borders and messages
- Buttons: 6px radius, full-width, 36px height (lg size)
- Inputs: 6px radius, 32px height, 1px border, focus ring 2px Electric Indigo
- Cards: 8px radius, 1px border, 16px internal padding

**Page Structure:**
1. **Full-page background:** Solid Void Black (#09090B), no pattern, no gradient
2. **Login card:** Centered vertically and horizontally. Onyx Surface (#0F0F12) background, 8px border-radius, 1px Charcoal Border (#1F1F23). Max width 400px. Generous 32px internal padding
3. **Branding:** "UnifiedCommerce" wordmark in Pure White (#FAFAFA), 18px semibold Inter, with a small indigo diamond icon to the left. Centered alignment
4. **Subtitle:** "Sign in to your store" in Slate Text (#A1A1AA), 14px regular, 8px below wordmark
5. **Email labeled text input:** Label "Email" above, Graphite Muted (#27272A) fill, Charcoal border, placeholder "you@company.com" in Slate. 32px height, 6px radius
6. **Password labeled text input:** Same styling as email. Toggle visibility icon right-aligned inside the field
7. **Primary call-to-action button:** "Sign in", full-width, Electric Indigo (#6366F1) fill, Pure White text, 36px height, 6px radius
8. **Forgot password link:** "Forgot password?" in Slate Text (#A1A1AA), 12px caption, centered below button
9. **Spacing:** 24px between card sections, 16px between form fields. No social login, no illustrations

---

## Screen 2: Dashboard — Morning operational overview

A data-dense operational dashboard for a professional ecommerce admin. Dark theme with high-contrast accents, inspired by Linear and Stripe. Desktop web application showing KPIs, quick actions, and recent orders for merchants starting their day.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, information-dense, zero decorative waste
- Font: Inter variable weight; JetBrains Mono for order IDs
- Background: Void Black (#09090B) — page canvas
- Surface: Onyx Surface (#0F0F12) — cards, sidebar, table header
- Border: Charcoal Border (#1F1F23) — card edges, dividers, table row borders
- Input Fill: Graphite Muted (#27272A) — hover states
- Primary Accent: Electric Indigo (#6366F1) — active nav, links
- Selected Tint: Ghost Indigo (#6366F114) — active sidebar item
- Text Primary: Pure White (#FAFAFA) — headings, KPI values
- Text Secondary: Slate Text (#A1A1AA) — labels, timestamps
- Text Body: Silver Body (#D4D4D8) — table content
- Success: Emerald (#22C55E) — positive change indicators
- Warning: Amber (#F59E0B) — pending, low stock
- Error: Rose (#EF4444) — negative change indicators
- Info: Sky (#38BDF8) — processing status badges
- Status Badges: pill-shaped, 15% opacity background + full color text
- Sidebar: 240px wide, Onyx Surface background, 32px item height
- KPI Value: 28px semibold for metric numbers

**Page Structure:**
1. **Navigation sidebar (left, fixed 240px):** Onyx Surface (#0F0F12) background. Logo "UC" at top. Nav groups: Overview (active — Ghost Indigo background, Electric Indigo left accent bar, white text), Orders, Catalog, Inventory, Customers, Promotions, Analytics, Settings. Each item has icon + label. Footer: user avatar circle + name
2. **Top bar (sticky):** Breadcrumb "Dashboard" in Pure White left-aligned. Right side: search icon with "Cmd+K" hint badge, notification bell, user avatar dropdown
3. **Greeting:** "Good morning, Sarah" heading 1 (24px semibold), today's date "Monday, March 31" in Slate caption below
4. **KPI metric cards (row of 4):** Each card: Onyx Surface background, 8px radius, 1px Charcoal border. Large KPI value (28px semibold white), label in Slate caption, percentage change badge (Emerald for positive, Rose for negative). Cards: Revenue ($12,847 +12.3%), Orders (47 +8.1%), AOV ($273 -2.1%), Conversion (3.2% +0.4%)
5. **Quick actions row:** Three pill-shaped secondary buttons with icons — "Fulfill 5 orders" (package icon), "3 low-stock items" (Amber warning badge), "2 pending returns" (Rose badge)
6. **Recent Orders data table:** Sticky header row on Onyx Surface. Columns: Order # (JetBrains Mono, clickable indigo link), Customer name, Total ($), Status badge (Fulfilled=Emerald, Processing=Amber, Pending=Sky), Date (Slate caption). 10 rows, 40px row height, 1px bottom border per row. Hover: Ghost Indigo tint

---

## Screen 3: Orders List — Browse, filter, and bulk-manage orders

A data-dense order management list for a professional ecommerce admin. Dark theme, high-contrast. Desktop web application with filterable data table, bulk selection, and floating action bar for batch operations.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, table-focused, power-user density
- Font: Inter variable weight; JetBrains Mono for order numbers
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — sidebar, table header, action bar
- Border: Charcoal Border (#1F1F23) — table rows, filter inputs
- Input Fill: Graphite Muted (#27272A) — filter dropdowns, search input
- Primary Accent: Electric Indigo (#6366F1) — links, active nav, primary buttons
- Selected Tint: Ghost Indigo (#6366F114) — selected row background
- Text Primary: Pure White (#FAFAFA) — page title, headings
- Text Secondary: Slate Text (#A1A1AA) — filter labels, date column
- Text Body: Silver Body (#D4D4D8) — table cell content
- Status Badges: pill-shaped, dot + label, 15% opacity bg
- Data Table: 40px rows, sticky header, no zebra striping
- Buttons: Primary 6px radius indigo, Secondary transparent + border

**Page Structure:**
1. **Navigation sidebar:** Orders group active (Ghost Indigo background, Electric Indigo left accent, white text)
2. **Top bar:** Breadcrumb "Orders > All Orders" in Pure White
3. **Page header:** Title "Orders" heading 1 left. "Export" secondary button right-aligned
4. **Filter row:** Horizontal bar with status dropdown (All/Pending/Confirmed/Processing/Fulfilled/Refunded), date range picker, search input ("Search orders..."). Active filter chips below with dismiss X
5. **Data table:** Sticky header on Onyx Surface. Columns: checkbox (bulk select), Order # (mono, indigo link), Customer name, Items count, Total ($, right-aligned), Payment badge, Fulfillment status badge (color-coded pills), Date (Slate caption). 20 visible rows. Selected rows: Ghost Indigo bg + left Electric Indigo accent bar
6. **Floating action bar (when rows selected):** Fixed bottom-center, Onyx Surface card, 8px radius. Shows "3 selected" count. Buttons: "Mark Fulfilled" (primary indigo), "Print Labels" (secondary), "Export" (secondary), "Cancel" (ghost)
7. **Pagination:** Bottom right — "1-20 of 342" text in Slate, prev/next icon buttons

---

## Screen 4: Order Detail — Slide-over panel with status transitions

A detailed order view as a right-aligned slide-over panel for a professional ecommerce admin. Dark theme. Overlays the orders list with order items, customer info, payment details, timeline, and status transition buttons.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, detail-focused
- Font: Inter variable weight; JetBrains Mono for order ID, transaction ID
- Background: 50% black overlay behind panel
- Surface: Onyx Surface (#0F0F12) — panel background
- Border: Charcoal Border (#1F1F23) — section dividers, card borders
- Primary Accent: Electric Indigo (#6366F1) — next-action button, links
- Text Primary: Pure White (#FAFAFA) — order number heading
- Text Secondary: Slate Text (#A1A1AA) — timestamps, secondary labels
- Text Body: Silver Body (#D4D4D8) — descriptions, addresses
- Success: Emerald (#22C55E) — "Paid" badge
- Warning: Amber (#F59E0B) — "Processing" status badge
- Error: Rose (#EF4444) — refund button text
- AI Accent: Lavender (#A78BFA) — fraud risk insight card border
- Slide-over: 480px wide, right-aligned, smooth slide animation

**Page Structure:**
1. **Overlay:** Semi-transparent black (50%) covering the orders list behind
2. **Panel (right-aligned, 480px wide):** Onyx Surface background, sharp left edge
3. **Panel header:** "Order #UC-1047" in heading 2 JetBrains Mono. Status badge "Processing" (Amber pill) inline. Close X button top-right corner
4. **Status transition buttons:** Horizontal row — "Confirm" (disabled gray, done), "Process" (disabled, current), "Fulfill" (primary Electric Indigo, next action), "Refund" (ghost button, Rose text)
5. **Order Items section:** Heading 3 "Items". List of 3 line items — product thumbnail (48px square, 4px radius), product name (Silver body), variant text (Slate caption), quantity, line total right-aligned. Below items: subtotal, shipping, tax rows, then bold order total
6. **Customer card:** Onyx Surface card with Charcoal border. Customer name (indigo link), email (Slate), shipping address (Silver body text)
7. **Payment card:** Payment method icon + "Visa ending 4242", "Paid" Emerald badge, transaction ID in mono caption
8. **Timeline section:** Vertical timeline with small dots connected by lines. Entries: "Order placed" + timestamp, "Payment confirmed", "Processing started". Slate timestamps, Silver descriptions
9. **AI insight placeholder:** Subtle Lavender (#A78BFA) left-bordered card at bottom — "Fraud risk: Low" with sparkle icon. Muted, non-intrusive

---

## Screen 5: Products List — Browse catalog with grid/list toggle

A catalog browsing screen for a professional ecommerce admin. Dark theme. Desktop web application with data table of products, filters, bulk actions, and an AI insight banner for missing descriptions.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, catalog-browsing density
- Font: Inter variable weight; JetBrains Mono for SKU codes
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — sidebar, table header, cards
- Border: Charcoal Border (#1F1F23) — table rows, card edges
- Input Fill: Graphite Muted (#27272A) — filter inputs
- Primary Accent: Electric Indigo (#6366F1) — "Add Product" button, product name links
- Text Primary: Pure White (#FAFAFA) — page title
- Text Secondary: Slate Text (#A1A1AA) — SKU, filter labels
- Success: Emerald (#22C55E) — "Active" status badge
- Error: Rose (#EF4444) — low stock quantity text
- AI Accent: Lavender (#A78BFA) — insight banner border
- Status Badges: pill-shaped, 15% opacity bg
- Data Table: 40px rows, sticky header

**Page Structure:**
1. **Navigation sidebar:** Catalog group expanded, Products item active (Ghost Indigo + indigo accent)
2. **Top bar:** Breadcrumb "Catalog > Products" in Pure White
3. **Page header:** Title "Products" heading 1 left. Right side: "Add Product" primary button (Electric Indigo, plus icon), grid/list toggle (two small icon buttons, list active with indigo tint)
4. **AI insight banner:** Full-width subtle card at top of content — Lavender left border, Onyx background. Sparkle icon + "3 products need descriptions" in Silver text + "Review" indigo link. Dismissible with X
5. **Filter row:** Search input ("Search products..."), type dropdown (Physical/Digital/Subscription), status dropdown (Active/Draft/Archived), category dropdown
6. **Data table:** Sticky header. Columns: checkbox, thumbnail (40px square, 4px radius), Product name (bold Silver, clickable indigo), SKU (JetBrains Mono, Slate), Category badge (Slate pill), Price (right-aligned), Stock qty (Rose text if low, Silver if healthy), Status badge (Active=Emerald, Draft=Slate), three-dot action menu. 15 rows visible
7. **Pagination:** Bottom — "1-15 of 89" in Slate, page navigation buttons

---

## Screen 6: Product Editor — Tabbed form with two-column layout

A product editing screen for a professional ecommerce admin. Dark theme. Desktop web application with tabbed navigation, form inputs, and a right sidebar for status/media. Includes an AI "Generate" button for descriptions.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, form-heavy editor
- Font: Inter variable weight; JetBrains Mono for slug field
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — cards, right sidebar panels
- Border: Charcoal Border (#1F1F23) — card edges, input borders, dashed upload zone
- Input Fill: Graphite Muted (#27272A) — all text inputs, dropdowns, textareas
- Primary Accent: Electric Indigo (#6366F1) — active tab underline, "Save" button
- Text Primary: Pure White (#FAFAFA) — breadcrumb, active tab
- Text Secondary: Slate Text (#A1A1AA) — inactive tabs, slug text, upload hint
- Text Body: Silver Body (#D4D4D8) — form labels
- Success: Emerald (#22C55E) — "Active" status dot
- Error: Rose (#EF4444) — "Delete" action in menu
- AI Accent: Lavender (#A78BFA) — "Generate with AI" button text
- Inputs: 6px radius, 32px height, 1px border
- Cards: 8px radius, 1px Charcoal border, 16px padding

**Page Structure:**
1. **Top bar:** Breadcrumb "Catalog > Products > Wireless Headphones Pro" in Pure White. Right side: "Save" primary button (indigo), "Discard" ghost button, three-dot menu (Archive, Delete in Rose)
2. **Two-column layout — Left column (65%):** Horizontal tabs row — General (active, Electric Indigo underline), Attributes, Variants, Pricing, Media, SEO (all Slate text). Active tab content below
3. **General tab content:** Product name text input (pre-filled "Wireless Headphones Pro"), slug input (auto-generated value in JetBrains Mono, Slate text), description textarea (200px height) with "Generate with AI" ghost button in Lavender text beside the label. Category dropdown, brand dropdown, product type segmented control (Physical/Digital/Subscription)
4. **Right column (35%):** "Status" card — dropdown (Active/Draft/Archived) with Emerald dot beside "Active". "Organization" card — tags input with removable chip-style tags. "Thumbnail" card — dashed Charcoal border drop zone, "Drop image or click to upload" hint in Slate, upload icon centered
5. **Form styling:** All inputs 32px height, Graphite Muted background, 6px radius, 1px Charcoal border. Labels in Silver body above each input. 16px gap between fields

---

## Screen 7: Inventory Dashboard — Stock levels with quick adjust

An inventory management screen for a professional ecommerce admin. Dark theme. Desktop web application showing stock levels per warehouse with metric summary cards, filters, inline quick-adjust controls, and AI reorder suggestions.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, inventory-focused data density
- Font: Inter variable weight; JetBrains Mono for SKU codes
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — cards, table header, popover
- Border: Charcoal Border (#1F1F23) — card edges, table rows
- Input Fill: Graphite Muted (#27272A) — filter inputs, adjust popover input
- Primary Accent: Electric Indigo (#6366F1) — "Adjust" button, active nav
- Text Primary: Pure White (#FAFAFA) — page title, metric values
- Text Secondary: Slate Text (#A1A1AA) — reserved qty, labels
- Warning: Amber (#F59E0B) — "Low Stock" metric, low stock row accent
- Error: Rose (#EF4444) — "Out of Stock" metric, out-of-stock dots
- Success: Emerald (#22C55E) — healthy stock indicator dots
- Info: Sky (#38BDF8) — incoming stock badge
- AI Accent: Lavender (#A78BFA) — reorder suggestion row border

**Page Structure:**
1. **Navigation sidebar:** Inventory item active (Ghost Indigo + indigo accent)
2. **Top bar:** Breadcrumb "Inventory > Stock Levels"
3. **Page header:** Title "Inventory" heading 1
4. **Summary metric cards (row of 3):** Compact Onyx Surface cards — "Total SKUs" (456, white), "Low Stock" (12, Amber text), "Out of Stock" (3, Rose text). Each with Charcoal border
5. **Filter row:** Search input ("Search product or SKU..."), warehouse dropdown ("All Warehouses" / "NYC Warehouse" / "LA Warehouse"), stock level filter (All / Low Stock / Out of Stock)
6. **AI reorder suggestion:** Lavender left-bordered row at top of table — sparkle icon + "Reorder suggested: 200 units of SKU-WH100 by Apr 12" in Silver + "Create PO" indigo link
7. **Data table:** Sticky header. Columns: product name with small thumbnail, SKU (mono), Warehouse, Available qty (right-aligned number), Reserved (Slate), Incoming (Sky badge if > 0), Status dot (Emerald=healthy, Amber=low, Rose=out). Low stock rows have Amber left border accent. +/- icon buttons beside Available qty
8. **Quick adjust popover:** Small Onyx Surface card appearing inline — number input, reason dropdown (Received/Damaged/Correction/Return), "Adjust" primary button

---

## Screen 8: Customers List — Browse with AI segment badges

A customer management list for a professional ecommerce admin. Dark theme. Desktop web application with data table, AI-computed segment badges, search, filters, and bulk action bar.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, customer data density
- Font: Inter variable weight
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — sidebar, table header, action bar
- Border: Charcoal Border (#1F1F23) — table rows, filter inputs
- Input Fill: Graphite Muted (#27272A) — search, dropdowns
- Primary Accent: Electric Indigo (#6366F1) — customer name links, active nav
- Selected Tint: Ghost Indigo (#6366F114) — selected rows
- Text Primary: Pure White (#FAFAFA) — page title
- Text Secondary: Slate Text (#A1A1AA) — email, date columns
- Text Body: Silver Body (#D4D4D8) — table content
- Success: Emerald (#22C55E) — "Champions" segment badge
- Warning: Amber (#F59E0B) — "At Risk" segment badge
- Info: Sky (#38BDF8) — "New" segment badge
- Status Badges: pill-shaped, 15% opacity bg

**Page Structure:**
1. **Navigation sidebar:** Customers active (Ghost Indigo + indigo accent)
2. **Top bar:** Breadcrumb "Customers > All Customers"
3. **Page header:** Title "Customers" heading 1 left. "Export" secondary button right
4. **Filter row:** Search input ("Search by name, email, phone..."), segment dropdown (All/Champions/Loyal/At Risk/Lost), customer group dropdown, date joined range picker
5. **Data table:** Sticky header. Columns: checkbox, avatar circle (32px, initials on randomized muted color), Customer name (bold, indigo link), Email (Slate), Orders count, Total spent ($, right-aligned), Segment badge (Champions=Emerald pill, At Risk=Amber pill, New=Sky pill), Last order date (Slate caption). 20 rows, 40px height
6. **Floating action bar (when selected):** "2 selected", "Add to Group" button, "Export" button, "Send Email" button
7. **Pagination:** "342 customers" total count, page navigation

---

## Screen 9: Customer Detail — Single-pane profile with AI churn insight

A customer detail view for a professional ecommerce admin. Dark theme. Desktop web application with two-column layout showing profile, order history, stats, addresses, groups, notes, and AI engagement insights.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, detail view
- Font: Inter variable weight; JetBrains Mono for order numbers
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — all cards
- Border: Charcoal Border (#1F1F23) — card edges, table rows
- Primary Accent: Electric Indigo (#6366F1) — "Create Order" button, order links
- Text Primary: Pure White (#FAFAFA) — customer name heading
- Text Secondary: Slate Text (#A1A1AA) — email, phone, dates
- Text Body: Silver Body (#D4D4D8) — addresses, table content
- Success: Emerald (#22C55E) — "Champion" badge, "Very Low" churn risk
- AI Accent: Lavender (#A78BFA) — engagement insight card border
- KPI Value: 28px semibold for total spent

**Page Structure:**
1. **Top bar:** Breadcrumb "Customers > Sarah Chen". Right: "Create Order" primary button (indigo), "Send Email" secondary button, three-dot menu
2. **Left column (65%) — Profile card:** Name "Sarah Chen" heading 2, email + phone in Slate, "Champion" Emerald segment badge. "Joined Mar 2024" caption
3. **Left column — Order History section:** Heading 3 "Order History". Data table: Order # (mono, indigo link), Date, Items, Total, Status badge. 10 most recent rows. "View all 47 orders" indigo link below table
4. **Right column (35%) — Stats card:** Large KPI: Total spent $12,847 (28px semibold white). Below: Orders (47), Avg order ($273), Last order (Mar 28) in Silver body
5. **Right column — Addresses card:** Default shipping + billing addresses in Silver body text. "Edit" ghost button on each
6. **Right column — Customer Groups card:** Tag chips: "VIP", "Wholesale" — removable with X
7. **Right column — Notes card:** Textarea for internal notes, Silver body text
8. **Right column — AI insight card:** Lavender left border, Onyx background. Sparkle icon. "Last purchase: 3 days ago (avg interval: 14 days). Customer is highly engaged." Silver text. Below: "Churn risk: Very Low" in Emerald text

---

## Screen 10: Promotions — List with tabbed status and create wizard

A promotions management screen for a professional ecommerce admin. Dark theme. Desktop web application with tabbed promotion list (Active/Scheduled/Expired), data table with usage progress bars, and a 4-step creation wizard modal.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, promotion management
- Font: Inter variable weight; JetBrains Mono for promo codes
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — cards, table header, modal
- Border: Charcoal Border (#1F1F23) — card edges, table rows, modal border
- Primary Accent: Electric Indigo (#6366F1) — active tab, "Create" button, stepper active
- Text Primary: Pure White (#FAFAFA) — page title, promotion names
- Text Secondary: Slate Text (#A1A1AA) — inactive tabs, stepper inactive steps
- Success: Emerald (#22C55E) — "Active" status badge
- Info: Sky (#38BDF8) — "Percentage" type badge
- AI Accent: Lavender (#A78BFA) — "BOGO" type badge
- Buttons: Primary 6px radius indigo with plus icon

**Page Structure:**
1. **Navigation sidebar:** Promotions active (Ghost Indigo + indigo accent)
2. **Top bar:** Breadcrumb "Promotions > Active"
3. **Page header:** Title "Promotions" heading 1 left. "Create Promotion" primary button right (plus icon)
4. **Horizontal tabs:** Active (selected — Electric Indigo underline, count badge "5"), Scheduled (count "2"), Expired (count "12"). Tabs in Slate, active in white
5. **Data table:** Columns: Promotion name (bold), Code (JetBrains Mono "SUMMER25"), Type badge (Percentage=Sky, Fixed=Slate, BOGO=Lavender pill), Discount (-20%), Usage ("145 / 500" with subtle progress bar beneath), Revenue ($3,420), Valid until date, Status (Active=Emerald). Clickable rows
6. **Create wizard modal (overlaying):** Centered Onyx Surface card, 560px wide, 12px radius. 4-step horizontal stepper at top: "Type" (active, indigo circle + white text), "Rules" (Slate), "Schedule" (Slate), "Review" (Slate). Step 1: four radio cards — "Percentage Discount", "Fixed Amount", "Buy X Get Y", "Free Shipping". Each card: Onyx bg, icon, title, description. Selected: Electric Indigo border. Footer: "Cancel" ghost, "Next" primary

---

## Screen 11: Analytics — Revenue trends with AI-narrated insights

An analytics overview for a professional ecommerce admin. Dark theme. Desktop web application with AI-narrated summary card, KPI metrics with sparklines, revenue area chart, top products table, and customer acquisition chart.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, analytics and charting
- Font: Inter variable weight
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — cards, chart background
- Border: Charcoal Border (#1F1F23) — card edges, chart axis
- Primary Accent: Electric Indigo (#6366F1) — chart fill, active segment
- Text Primary: Pure White (#FAFAFA) — page title, KPI values
- Text Secondary: Slate Text (#A1A1AA) — axis labels, chart legend
- Text Body: Silver Body (#D4D4D8) — insight text, table content
- Success: Emerald (#22C55E) — positive change badges
- Error: Rose (#EF4444) — negative change badges
- AI Accent: Lavender (#A78BFA) — narrated insight card left border

**Page Structure:**
1. **Navigation sidebar:** Analytics active
2. **Top bar:** Breadcrumb "Analytics > Overview". Right: date range picker "Last 30 days" with calendar dropdown
3. **AI narrated insight card:** Full-width Onyx Surface card, Lavender left border (4px). Sparkle icon. Text: "Revenue is up 12% this month, driven by the new Spring Collection. Conversion rate improved after the checkout redesign. Watch: Cart abandonment increased 5% on mobile." Silver body text. "Dismiss" ghost button right
4. **KPI cards row (4):** Revenue ($48,320 +12% Emerald), Orders (176 +8%), Conversion (3.4% +0.2%), AOV ($274 -1% Rose). Each card with sparkline mini chart below the value
5. **Revenue area chart:** Large chart (400px height), Onyx Surface card. Electric Indigo fill with gradient fade to transparent. X-axis dates, Y-axis dollar amounts. Hover tooltip. Segmented control above: "Revenue" (active), "Orders", "Visitors"
6. **Bottom two cards side by side:** Left: "Top Products" data table — rank #, product name, units sold, revenue, horizontal bar showing relative performance. Right: "Customer Acquisition" area chart — two-tone (Indigo for new, Slate for returning), legend below

---

## Screen 12: Settings — Store configuration

A store settings screen for a professional ecommerce admin. Dark theme. Desktop web application with grouped form sections in cards — general info, shipping zones table, and notification toggles.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, settings/forms
- Font: Inter variable weight
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — all section cards
- Border: Charcoal Border (#1F1F23) — card edges, input borders, table dividers
- Input Fill: Graphite Muted (#27272A) — text inputs, dropdowns
- Primary Accent: Electric Indigo (#6366F1) — "Save" button, toggle on-state
- Text Primary: Pure White (#FAFAFA) — page title, section headings
- Text Secondary: Slate Text (#A1A1AA) — descriptions, helper text
- Text Body: Silver Body (#D4D4D8) — form labels, table content
- Inputs: 6px radius, 32px height, 1px Charcoal border
- Cards: 8px radius, 1px border, 24px padding, 16px gap between cards

**Page Structure:**
1. **Navigation sidebar:** Settings group expanded — Store (active), Users, API Keys, Webhooks, Audit Log, Jobs as sub-items
2. **Top bar:** Breadcrumb "Settings > Store"
3. **Page header:** Title "Store Settings" heading 1
4. **"General" card:** Store name text input, store URL input (lock icon, read-only hint), default currency dropdown (USD), timezone dropdown. "Save Changes" primary button aligned right within card
5. **"Shipping" card:** Heading 2 "Shipping Zones". Table: Zone name, Countries (tag chips), Rate type (Flat/Weight-based badge), Rate amount. "Add Zone" ghost button with plus icon below table
6. **"Notifications" card:** Heading 2 "Notifications". Toggle switch rows: Order confirmation email, Shipping notification, Low stock alerts, Daily summary email. Each row: label left, description caption below in Slate, toggle switch right (indigo when on)

---

## Screen 13: Settings — API Keys management

An API key management screen for a professional ecommerce admin. Dark theme. Desktop web application with data table of keys and a creation modal with permission checkboxes grouped by resource.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, developer-focused settings
- Font: Inter variable weight; JetBrains Mono for key prefixes
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — table header, modal
- Border: Charcoal Border (#1F1F23) — table rows, modal border, input borders
- Input Fill: Graphite Muted (#27272A) — modal inputs
- Primary Accent: Electric Indigo (#6366F1) — "Create" button, checkbox checked
- Text Primary: Pure White (#FAFAFA) — page title, key names
- Text Secondary: Slate Text (#A1A1AA) — description text, "Last used" time
- Info: Sky (#38BDF8) — "Storefront" scope badge
- AI Accent: Lavender (#A78BFA) — "Admin" scope badge
- Success: Emerald (#22C55E) — active status dot
- Error: Rose (#EF4444) — "Revoke" button, "Never" used text

**Page Structure:**
1. **Navigation sidebar:** Settings > API Keys active
2. **Top bar:** Breadcrumb "Settings > API Keys"
3. **Page header:** Title "API Keys" heading 1 left. Description "Manage API keys for programmatic access to your store." in Slate below. "Create API Key" primary button right
4. **Data table:** Columns: Name (bold), Key prefix (JetBrains Mono "sk_store_...7x4f"), Scope badge (Storefront=Sky pill, Admin=Lavender pill), Permissions summary (truncated Silver text), Created date, Last used (Slate relative time, or "Never" in Rose), Status (Active=Emerald dot, Revoked=Slate dot), Actions: "Revoke" ghost button in Rose, copy icon
5. **Create modal (overlaying):** Centered Onyx Surface card, 480px wide, 12px radius. Title "Create API Key" heading 2. Fields: Name input, Scope dropdown (Storefront/Admin). Permissions checklist grouped by resource — Catalog, Orders, Customers, Inventory — each with checkboxes (read/create/update/delete) + "Select All" toggle per group. Expiry dropdown (Never/30 days/90 days/1 year). Footer: "Cancel" ghost, "Create Key" primary

---

## Screen 14: Settings — Audit Log viewer

A dense audit log viewer for a professional ecommerce admin. Dark theme. Desktop web application with maximum-density data table, filterable by actor/action/resource/date.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, log viewer, maximum density
- Font: Inter variable weight; JetBrains Mono for timestamps, IP addresses
- Background: Void Black (#09090B)
- Surface: Onyx Surface (#0F0F12) — table header
- Border: Charcoal Border (#1F1F23) — table rows
- Input Fill: Graphite Muted (#27272A) — filter inputs
- Primary Accent: Electric Indigo (#6366F1) — resource links
- Text Primary: Pure White (#FAFAFA) — page title
- Text Secondary: Slate Text (#A1A1AA) — IP addresses, timestamps
- Text Body: Silver Body (#D4D4D8) — change summaries, actor names
- Success: Emerald (#22C55E) — "Created" action badge
- Info: Sky (#38BDF8) — "Updated" action badge
- Error: Rose (#EF4444) — "Deleted" action badge
- Data Table: 36px rows for maximum density, no bulk actions

**Page Structure:**
1. **Navigation sidebar:** Settings > Audit Log active
2. **Top bar:** Breadcrumb "Settings > Audit Log"
3. **Page header:** Title "Audit Log" heading 1
4. **Filter row:** Search input ("Search by user or action..."), actor dropdown (All Users + specific names), action type dropdown (All/Create/Update/Delete/Login), resource dropdown (All/Orders/Products/Inventory/Users), date range picker
5. **Data table (maximum density):** 36px row height. Columns: Timestamp (JetBrains Mono, caption size "2024-03-28 14:32:07"), Actor (24px avatar circle + name), Action badge (Created=Emerald pill, Updated=Sky pill, Deleted=Rose pill), Resource + ID ("Order #UC-1047" as indigo link), Changes summary (truncated "status: processing → fulfilled"), IP address (mono, Slate). Subtle alternating row tint for readability
6. **Pagination:** "Showing 1-50 of 2,847" in Slate, prev/next buttons. No bulk actions

---

## Screen 15: Command Palette — Global search overlay

A command palette modal overlay for a professional ecommerce admin. Dark theme. Centered floating modal with grouped search results (orders, products, customers, actions) and keyboard navigation hints. Triggered by Cmd+K.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, Desktop-first
- Theme: Dark, professional, search/command interface
- Font: Inter variable weight; JetBrains Mono for order numbers
- Background: 50% black overlay over current page
- Surface: Onyx Surface (#0F0F12) — modal background
- Border: Charcoal Border (#1F1F23) — modal border, section dividers, bottom bar
- Primary Accent: Electric Indigo (#6366F1) — active result left accent
- Selected Tint: Ghost Indigo (#6366F114) — hovered/active result background
- Text Primary: Pure White (#FAFAFA) — primary result text
- Text Secondary: Slate Text (#A1A1AA) — secondary text, keyboard hints, section headers
- Modal: 560px wide, max 480px tall, 12px border-radius

**Page Structure:**
1. **Overlay:** Semi-transparent black (50%) covering entire viewport
2. **Modal (centered, 560px wide):** Onyx Surface (#0F0F12) background, 12px radius, 1px Charcoal border. Max height 480px with internal scroll
3. **Search input (top):** Full-width, no border, transparent background. Magnifying glass icon left. Placeholder "Search orders, products, customers..." in Slate. "Esc" keyboard hint badge right
4. **Results — "Orders" group:** Uppercase section header in Slate caption. Result rows (40px height): package icon, primary text bold ("Order #UC-1047 — Sarah Chen"), secondary text Slate ("$274.00 · Processing"), action arrow right. Active result: Ghost Indigo background + Electric Indigo left accent bar
5. **Results — "Products" group:** Same layout, box icon, product names
6. **Results — "Customers" group:** Person icon, customer names + email
7. **Results — "Actions" group:** Command icon, "Create Order", "Add Product", "View Analytics"
8. **Bottom bar:** Subtle Charcoal top border. Keyboard hints: "↑↓ Navigate", "↵ Open", "Esc Close" in Slate caption
