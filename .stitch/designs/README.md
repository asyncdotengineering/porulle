# Fashion POS — Stitch Generated Designs

11 of 15 screens generated via Google Stitch MCP into the project at
`projects/16456017047316932851` ("Fashion POS — Sri Lanka"). Design system
locked as **Luminous Commerce** (Shopify cream/mint transactional track:
canvas #fbfbf5, primary mint #c1fbd4, pistachio accent #d4f9e0, Inter font,
ROUND_FULL pill buttons).

## Round 1 — Cashier operational core + admin home (7/7)

| # | Screen | HTML | PNG | Status |
|---|---|---|---|---|
| 01 | Sign In (cashier select + PIN keypad) | ✅ | ✅ | Complete |
| 02 | Open Shift (declare starting cash) | ✅ | ✅ | Complete |
| 03 | Till — Sale Mode (the main screen) | ❌ | ✅ | PNG only — see note below |
| 05 | Payment (cash / card / split) | ✅ | ✅ | Complete |
| 06 | Sale Complete (receipt preview + delivery) | ✅ | ✅ | Complete |
| 09 | Close Shift (Z-report + cash reconciliation) | ✅ | ✅ | Complete |
| 10 | Admin Dashboard (analytics home) | ✅ | ✅ | Complete |

## Round 2 — Secondary cashier flows + admin (4/8)

| # | Screen | HTML | PNG | Status |
|---|---|---|---|---|
| 04 | Customer Attach (bottom-sheet modal) | ✅ | ✅ | Complete |
| 07 | Returns Lookup (find original order) | ✅ | ✅ | Complete |
| 08 | Return Item Select | — | — | **Not generated — Stitch timed out 4× on the two-column refund layout.** Retry later. |
| 11 | Inventory List (catalog table) | ✅ | ✅ | Complete |
| 12 | Product Detail / Edit | — | — | **Not generated — timed out on two-column form-with-variants-matrix layout.** Retry later. |
| 13 | Customer List | — | — | **Not generated — timed out on data-table layout.** Retry later. |
| 14 | Customer Detail | — | — | **Not generated — timed out on header-card + tabs layout.** Retry later. |
| 15 | Settings (store / hardware / notifications / staff) | ✅ | ✅ | Complete |

---

## How to review

Each `*.png` is a 2560-wide render of the screen. Open them in any image
viewer or drop them into Figma / Stitch's web app for inspection.

Each `*.html` is a self-contained Tailwind-CDN page with the Luminous Commerce
design tokens inlined. Open directly in a browser:

```bash
open .stitch/designs/01-sign-in.html
open .stitch/designs/02-open-shift.html
# ... etc
```

All screens share the same visual lineage because Stitch inherits the
project-level design system on every generation — colors, type, radius,
spacing, and pill button vocabulary are consistent across the set.

---

## Notes on the gaps

### Screen 03 — Till Sale Mode (PNG only)

The Till's split-pane layout (cart on the left + product tile grid on the
right + action bar at the bottom) is the most component-dense screen in the
set. Stitch's renderer consistently timed out at the MCP-call boundary on
this layout (≥5 attempts at varying prompt sizes from 1500 chars down to
50 chars), even though the screenshot DID generate server-side on the first
attempt — that PNG is preserved here. The HTML can be hand-coded from the
PNG during the React-conversion phase (Stage 5 of the Stitch workflow).

### Screens 08, 12, 13, 14 (not generated)

These four screens all share a common pattern: **two-column data-heavy
layouts with sidebars or tabs**. Stitch's MCP integration appears to have
a hard timeout that complex multi-region layouts exceed on the desktop
viewport. The same prompt patterns landed reliably for single-region
modals (04), single-table list with sidebar (11, 15), centered-card forms
(02, 06), and modal overlays (04).

To finish these four, recommended approaches in order of effort:

1. **Wait and retry** — Stitch server load varies; the same prompts that
   timed out earlier in the session landed when retried 5 minutes later
   (admin dashboard, inventory list, settings all landed this way).
2. **Generate via the Stitch web UI** at https://stitch.withgoogle.com/app/projects/16456017047316932851
   — the web UI has its own longer timeout and is more forgiving of complex
   prompts. Open the project there, use the same DESIGN.md (already locked
   as the project's design system), and generate the four missing screens
   interactively.
3. **Hand-code from the screen briefs** in `.stitch/screen-prompts.md` —
   the four screens are fully specified at the prompt level. Building them
   directly from those briefs takes about an hour each in HTML+Tailwind.

---

## Files in this directory

- `01-sign-in.{html,png}` through `15-settings.{html,png}` — the generated screens
- `README.md` — this file
