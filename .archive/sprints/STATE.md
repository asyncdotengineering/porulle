# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `Phase-B-closeout`
**Sprint name:** Foundation Repair Complete (sprints 0–4 + comprehensive Phase B)
**Status:** `complete — all three validation gates green ✅`
**Branch:** `foundation-repair` (39 commits ahead of `main`)
**Goal:** All 5 sprint goals delivered. `bun run check-types` 38/38, `bun run test` 56/56, `bun run lint` 25/25 — all green. Drizzle hash drift fixed workspace-wide via `@unifiedcommerce/core/drizzle` re-export. extraAuthPlugins committed at `cd51ef6`.

## Load-bearing reading for sprint 0

The session running sprint 0 must read these in this order before delegating any story:

1. `sprints/WBS.md` — full read; this is the plan.
2. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
3. `FRAMEWORK-WIKI-PHASE-2.md` §10 (The Pre-Extraction Punch List) — the source punch list with file:line citations for every Sprint-0 fix.
4. `FRAMEWORK-WIKI-PHASE-2.md` §2 (Live Bugs) — context for LB-4 (inventory lost-update) and LB-7 (order number race).
5. `FRAMEWORK-WIKI-PHASE-2.md` §6 (Operational Reality) — context for F-1 (compensation no remediation).
6. `packages/core/src/modules/inventory/service.ts` lines 289–377 + `packages/core/src/modules/inventory/repository/index.ts` lines 225–237 — the read-modify-write call paths to fix in S0-02.
7. `packages/core/src/modules/orders/repository/index.ts` — `getNextOrderNumber()` location for S0-03.
8. `packages/core/src/kernel/compensation/executor.ts` lines 46–51 + `packages/core/src/hooks/checkout-completion.ts` lines 161–168 — the swallowed-error sites for S0-05.
9. `packages/cli/templates/starter/` — the broken starter template to fix in S0-06.

## Last completed sprint

Phase B (consolidated review gate after Sprints 0–4)

## Last completed at

2026-05-09 (single session)

## Sprint history

| Sprint | Status | Stories | Commits |
|--------|--------|---------|---------|
| 0 — Foundation Hygiene + Critical Correctness | ✅ complete | 6 | 7 (`860dbaa`–`b230560`) |
| 1 — Multi-tenancy Hardening | ✅ complete | 6 | 6 (`fecf7c9`–`b549ba3`) |
| 2 — Live Bug Fixes + Reaper | ✅ complete | 6 | 6 (`cb0ec9a`–`763e9f6`) |
| 3 — Documentation Honesty + Onboarding | ✅ complete | 9 | 9 (`8d67b18`–`05fed47`) |
| 4 — Service Container Modernization | ✅ complete | 6 | 6 (`5c39b11`–`4ae8648`) |
| 5 — Typed Hooks + Framework Extraction | ⏭ deferred (user direction) | — | — |
| Phase B — consolidated review gate | ✅ complete (typecheck only — test/lint pending next session) | — | 2 (`7e448d0`, `ff40a2a`) |

When a sprint completes, append a new row entry referencing the WARMDOWN.md path.

## Backlog deltas this project life

`(none)`

## Open RFC amendments

`(none)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open wiki amendments.
