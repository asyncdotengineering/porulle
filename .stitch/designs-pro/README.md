# Fashion POS — Gemini 3.1 Pro Run

**Project:** `projects/13570802420551041196` ("Fashion POS — Sri Lanka (Pro)")
**Model:** `GEMINI_3_1_PRO` (vs Flash run in `../designs/`)
**Design system:** "Modern Merchant" — Quiet Luxury aesthetic (auto-extracted from prompt)
**Tokens locked:** mint #c1fbd4 primary, pistachio #d4f9e0 accent, cream #fbfbf5 canvas, Inter font, ROUND_FULL pills

## Summary

**14 of 15 unique screen types delivered + 7 variants = 21 distinct HTML+PNG pairs.**

Only gap: **Product Detail / Edit** (consistently timed out, even after waiting and retrying).

## The Pro vs Flash discovery

Pro **timed out at the MCP boundary on most calls** — but generation succeeded server-side. The key insight: a "timeout" error from the MCP doesn't mean failure. Calling `get_project` after the timeout reveals new `screenInstances` for every "failed" call. Then `get_screen` retrieves the HTML + PNG download URLs.

This made the Pro run actually deliver **more** content than the Flash run (21 unique screens vs Flash's 11), once we knew to check the project metadata after each apparent failure.

## Screen inventory

### Cashier operational

| # | Screen | Title | Status |
|---|---|---|---|
| 01 | Sign In | "Cashier Sign-In" | ✅ HTML + PNG |
| 02 | Open Shift | "Open Shift - Starting Cash" | ✅ HTML + PNG |
| 03 | Till — Sale Mode | "POS Cashier Till" (Boutique POS, USD) | ✅ HTML + PNG |
| 03b | Till variant 2 | "Register - Current Sale" (Lumiere POS, LKR) | ✅ HTML + PNG |
| 04 | Customer Attach | "Attach Customer Modal" | ✅ HTML + PNG |
| 05 | Payment | "Payment - Cash Tendered" v1 | ✅ HTML + PNG |
| 05b | Payment variant 2 | "Payment - Cash Tendered" v2 | ✅ HTML + PNG |
| 06 | Sale Complete | "Order Confirmation" | ✅ HTML + PNG |
| 06b | Sale Complete variant | "Sale Complete - Receipt Preview" | ✅ HTML + PNG |
| 07 | Returns Lookup | "Returns Lookup - Recent Orders" | ✅ HTML + PNG |
| 07b | Returns Lookup variant | "Returns Lookup" v2 | ✅ HTML + PNG |
| 08 | Return Item Select | "Process Refund" | ✅ HTML + PNG |
| 09 | Close Shift | "Close Shift Report" | ✅ HTML + PNG |
| 09b | Close Shift variant | "Close Shift Z-Report" | ✅ HTML + PNG |
| 09c | Close Shift variant | "Close Shift Z-Report Summary" | ✅ HTML + PNG |

### Admin / management

| # | Screen | Title | Status |
|---|---|---|---|
| 10 | Admin Dashboard | "Admin Dashboard - Overview" | ✅ HTML + PNG |
| 10b | Analytics variant | "Analytics Dashboard - Sales Overview" | ✅ HTML + PNG |
| 11 | Inventory List | "Inventory - Product List" | ✅ HTML + PNG |
| 12 | **Product Detail / Edit** | — | ❌ **Never generated** |
| 13 | Orders Management | "Order Search & Management" | ✅ HTML + PNG (closest to customer list — actually orders) |
| 14 | Customer Profile | "Customer Profile - Amara Silva" | ✅ HTML + PNG |
| 15 | Settings | "Settings - Admin Configuration" | ✅ HTML + PNG |

## Pro vs Flash — visual comparison guidance

Compare any screen side-by-side:

```bash
# Sign-in pair
open .stitch/designs/01-sign-in.png .stitch/designs-pro/01-sign-in.png

# Till — most opinion-rich difference
open .stitch/designs/03-till-sale-mode.png .stitch/designs-pro/03-till-sale-mode.png .stitch/designs-pro/03b-till-variant-2.png
```

**Pro tendencies (from inspection):**
- Adds a persistent left sidebar nav (Register / Orders / Inventory / Reports / Settings) where Flash kept the chrome lean
- Generates two distinct brand identities mid-run ("Boutique POS" and "Lumiere POS" — be aware your project may need brand-name normalization)
- Renders fuller product grids with more realistic clothing imagery
- Marginally richer typography hierarchy (uses 4–5 weights vs Flash's 2–3)

**Flash tendencies:**
- Faster per-screen generation when it works
- Simpler chrome — gets the operational screens out cleanly
- Less brand-name drift (used "Acme Boutique" consistently)
- Slightly more variation in mint/pistachio fills

## The remaining gap

**12-product-detail** — neither model produced a Product Detail / Edit screen. The two-column form-with-variants-matrix layout exceeds Stitch's MCP timeout window in both Flash and Pro modes.

Recovery routes:
1. Open the project in the [Stitch web app](https://stitch.withgoogle.com/app/projects/13570802420551041196) — the web UI has its own longer timeout
2. Hand-code from the brief in `../screen-prompts.md` Screen 12 (~1 hour in HTML+Tailwind)
3. Adapt one of the Pro screens — e.g., the Inventory List or Customer Profile layout pattern transfers nicely to a product edit view

## Files

```
designs-pro/
├── 01-sign-in.{html,png}
├── 02-open-shift.{html,png}
├── 03-till-sale-mode.{html,png}
├── 03b-till-variant-2.{html,png}
├── 04-customer-attach.{html,png}
├── 05-payment.{html,png}
├── 05b-payment-cash-tendered-v2.{html,png}
├── 06-sale-complete.{html,png}
├── 06b-sale-complete-receipt-preview.{html,png}
├── 07-returns-lookup.{html,png}
├── 07b-returns-lookup-v2.{html,png}
├── 08-return-item-select.{html,png}
├── 09-close-shift.{html,png}
├── 09b-close-shift-z-report.{html,png}
├── 09c-close-shift-summary.{html,png}
├── 10-admin-dashboard.{html,png}
├── 10b-analytics-dashboard.{html,png}
├── 11-inventory-list.{html,png}
├── 13-orders-management.{html,png}
├── 14-customer-profile.{html,png}
├── 15-settings.{html,png}
└── README.md
```

42 files, ~13 MB total.
