# Design System: UnifiedCommerce Admin

## 1. Visual Theme & Atmosphere

A professional, data-dense admin dashboard built for daily commerce operations. The aesthetic draws from Stripe Dashboard and Linear — clean surfaces, tight information density, and zero decorative waste. Every pixel earns its place by surfacing actionable data.

The vibe is **focused and efficient**: muted backgrounds that recede, crisp typography that scans fast, and accent colors reserved exclusively for status and actions. Dark mode is the default — operators spend hours here, and dark surfaces reduce fatigue. Light mode available as an alternative.

Design philosophy: "The best admin UI is invisible." No hero images, no gradients, no illustrations. Just structured data, clear hierarchy, and fast interactions. Inspired by Linear's density, Stripe's polish,.

## 2. Color Palette & Roles

### Dark Mode (Default)
- Void Black (#09090B) — Primary background, the canvas everything sits on
- Onyx Surface (#0F0F12) — Card backgrounds, sidebar, elevated surfaces
- Charcoal Border (#1F1F23) — Subtle borders between sections, dividers
- Graphite Muted (#27272A) — Secondary borders, hover states, input backgrounds
- Slate Text (#A1A1AA) — Secondary text, labels, placeholders, timestamps
- Silver Body (#D4D4D8) — Primary body text, table cell content
- Pure White (#FAFAFA) — Headings, high-emphasis text, primary values
- Electric Indigo (#6366F1) — Primary action buttons, active nav, links, focus rings
- Soft Indigo (#4F46E5) — Primary button hover state
- Ghost Indigo (#6366F114) — Selected row background, active sidebar item tint
- Emerald Success (#22C55E) — Fulfilled status, positive change, success toasts
- Amber Warning (#F59E0B) — Low stock alerts, pending status, warning badges
- Rose Error (#EF4444) — Failed orders, errors, destructive actions, declined payments
- Sky Info (#38BDF8) — Informational badges, processing status, neutral alerts
- Lavender AI (#A78BFA) — AI insight indicators, suggestion badges, smart recommendations

### Light Mode (Alternative)
- Cloud White (#FAFBFC) — Primary background
- Snow Surface (#FFFFFF) — Card backgrounds, elevated surfaces
- Mist Border (#E4E4E7) — Borders, dividers
- Fog Muted (#F4F4F5) — Hover states, input backgrounds
- Stone Text (#71717A) — Secondary text
- Iron Body (#3F3F46) — Primary body text
- Ink Black (#18181B) — Headings, high-emphasis text
- (Action colors remain the same across themes)

## 3. Typography Rules

**Font Family:** Inter — optimized for UI density, excellent at small sizes, variable weight support.

**Scale:**
- **Heading 1:** 24px / 32px line-height, Semibold (600) — Page titles only
- **Heading 2:** 18px / 28px line-height, Semibold (600) — Section headers, card titles
- **Heading 3:** 14px / 20px line-height, Medium (500) — Sub-section headers, table group headers
- **Body:** 14px / 20px line-height, Regular (400) — Table cells, descriptions, form labels
- **Caption:** 12px / 16px line-height, Regular (400) — Timestamps, secondary labels, helper text
- **Button Text:** 13px / 20px line-height, Medium (500) — All button labels
- **KPI Value:** 28px / 36px line-height, Semibold (600) — Dashboard metric numbers
- **Badge:** 11px / 16px line-height, Medium (500) — Status badges, tags, counts
- **Mono:** JetBrains Mono, 13px — Order IDs, API keys, code snippets

**Spacing:** 4px base unit. Tight leading for density. -0.01em letter-spacing on headings.

## 4. Component Stylings

* **Buttons:** Pill-shaped with 6px radius. Primary: Electric Indigo fill, white text. Secondary: transparent with border, slate text. Destructive: Rose Error fill, white text. Ghost: no border, subtle hover tint. Sizes: sm (28px), md (32px), lg (36px).

* **Cards/Containers:** 8px border-radius. Onyx Surface background. 1px Charcoal Border. No drop shadows — borders define elevation. 16px internal padding. Cards are flush to each other with 12px gaps.

* **Inputs/Forms:** 6px radius. Graphite Muted background. 1px Charcoal Border. On focus: Electric Indigo ring (2px). Error state: Rose Error border + caption. Placeholder text in Slate. Height: 32px (compact for density).

* **Data Tables:** Zebra-striping off — clean rows with 1px bottom border. Row height: 40px. Sticky header row with Onyx Surface background. Hover: Ghost Indigo row tint. Selected: Ghost Indigo with left Electric Indigo accent bar. Sortable columns show arrow indicator.

* **Status Badges:** Pill-shaped, 9999px radius. 6px horizontal padding. Tiny dot + label. Fulfilled/Active: Emerald. Pending/Processing: Amber. Failed/Cancelled: Rose. Draft: Slate. Color is 15% opacity background + full color text.

* **Navigation Sidebar:** 240px wide, collapsible to 48px (icon-only). Onyx Surface background. Items: 32px height, 8px radius on hover. Active item: Ghost Indigo background + Electric Indigo left accent + white text. Section headers in uppercase Caption style.

* **Command Palette:** Centered modal, 560px wide, Onyx Surface background with 12px radius. Search input at top. Results grouped by type (Orders, Products, Customers). Keyboard navigation with Ghost Indigo highlight. Cmd+K trigger.

* **Slide-over Panels:** Right-aligned, 480px wide. Onyx Surface background. Overlay: 50% black. Smooth 200ms slide animation. Close button top-right + Escape key.

* **Toast Notifications:** Bottom-right stack. 8px radius. Color-coded left border (4px). Auto-dismiss after 5 seconds. Undo action link for mutations.

## 5. Layout Principles

**Grid:** 12-column on desktop (1280px+), 8-column on tablet. Sidebar is fixed, content area scrolls independently. Max content width: 1200px centered within the content area.

**Spacing Scale:** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64px. Page padding: 24px. Card gaps: 12px. Section gaps: 24px. Form field gaps: 16px.

**Density:** This is a power-user tool. Favor information density over whitespace. Tables should show 15-20 rows without scrolling. Dashboard should show all KPIs + recent orders above the fold. No decorative spacing.

**Hierarchy:** Left sidebar (navigation) → Top bar (breadcrumbs + search + user) → Content area (page). Every page follows: Page title + actions → Filters/tabs → Content → Pagination.

**Responsive:** Sidebar collapses to hamburger at 1024px. Tables become card lists at 768px. Command palette is full-width on mobile. Priority: desktop-first — this is an operations tool.
