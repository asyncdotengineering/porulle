# Standdown — 2026-08-22

## Shipped

**In this conversation** — ten commits, `d794a72..eee722a`, all pushed:

- Closed the workaround audit: permission scopes replacing a write-permission proxy and a hard-coded role set (`88b8d18`); one organization answer at every layer for an actor-less request (`d56b71b`); a required actor on catalog reads, which immediately surfaced a live bug where list hydration ran anonymously (`14a6fb2`); staff grants gated on containment **and** rank (`8f4ecc3`); the POS refund ledger bound to its payout in one transaction (`eee722a`).
- Fixed two regressions this session had itself shipped — `88b8d18` broke four `plugin-pos` exchange tests and all three `plugin-layaway` tests, unnoticed for three commits (`1b392aa`).
- Repaired `pnpm check-types` from red to 48 of 48 and capped turbo concurrency after repo-wide runs drove load past 60 on 8 cores (`cb272ea`, `d63f05a`).
- Declared every column better-auth 1.7 writes and rewrote the parity guard that missed them (`9884856`).
- Ran red-team round 6 against RBAC administration and guest checkout — surfaces five prior rounds never touched. Verdict BREACHED, five reproduced findings, two HIGH.

**Since, in another session** — six commits, `eee722a..baa6bb3`, all pushed, and all six red-team blockers are `done` on the board:

- Gave a cart's checkout claim an owner so a losing checkout cannot release the winner's (`7a4f0a1`).
- Re-checked the inviter's authority at invitation acceptance (`7da1f88`).
- Made the last-owner guard atomic (`8b60de4`).
- Sent invoices to the address on the order, not the caller's (`07c0b22`).
- Refused Better Auth's organization membership endpoints outright (`fb876e4`).
- Bounded a guest's order read to a window after placement (`baa6bb3`) — this resolves the cart-secret lifetime decision.

## Decisions

- **`vapt/` is not version-controlled.** `.gitignore` now excludes `vapt/`, `scripts/*vapt*`, `**/seed-vapt.ts` and `*redteam*`, with the reasoning in the file: the repository is public and those artifacts read as a playbook against live deployments. Regression coverage for anything they find belongs in a normal test under `packages/*/test/`.
- **Better Auth's organization membership endpoints are refused**, rather than made to agree with `admin/staff.ts`. That file is already the governed surface; two systems agreeing is harder than one being closed.
- **A guest's order read is time-bounded** rather than the cart secret being rotated or revoked.
- `config.auth.defaultOrganizationId` is the deployment declaring that actor-less requests belong to that organization. Set, it resolves everywhere; unset, an actor-less request is refused.
- Staff grants require containment **and** rank — containment stops permission escalation, the rank floor preserves the ordering invariant, neither subsumes the other. A custom role carrying `*:*` floors at admin rank deliberately, so it can grant `admin` but never `owner`.
- Gate lists must match a change's blast radius, not its edit surface. A permission change to a shared read policy reaches every package that reads the catalog.
- Worker lineup: `cursor` on composer-2.5-fast for implementation, `codex` on gpt-5.6-luna xhigh for fixes after a failed review, `pi` on zai/glm-5.3 thinking-high for every review and the red team.

## Blocked / needs human

- **The 0.13.0 release is staged but not committed or published.** `changeset version` has run: all 13 changesets are consumed, `@porulle/core` reads 0.13.0 locally, npm is still 0.11.0, and every version bump and CHANGELOG edit sits uncommitted in the working tree. Three `vapt` script deletions are staged alongside.
- **Two changeset claims were corrected mid-flight** and are now inside the generated CHANGELOGs — verify the wording survived `changeset version` before publishing. The one that mattered: invitations were described as "now use the same checks" when only *creation* was checked; acceptance is fixed as of `7da1f88`, so that sentence is now true, but confirm it reads accurately.
- Standdown assembled from git, the board and direct conversation context rather than subagents, per this session's standing instruction not to dispatch agents unprompted.

## Still open

- Nothing is `todo`. `get_next_task` returns nothing actionable.
- In `scope`, ordered by how much they matter: **Unify "act on behalf of another customer" across cart, checkout and orders** — cart and checkout still gate on hard-coded role names, so a custom role holding `orders:create:on-behalf` works on direct order-create and fails cart-first, which is what a real POS does. Then **Make order attribution explicit instead of inferring it from a permission**, **Consolidate wildcard permission matching and pin the API-key containment direction**, **Make test actors carry the permissions their role config declares**.
- Push-path residuals in `scope`, none security-bearing: Woo dry-run `previousFields`, Shopify image push, Shopify residuals, echo-suppression residuals, push-catalog job residuals, media and price push triggers, conflict platform-value refresh, feed-ready catalog items.
- Older `scope`: store-example schema drift, field-ownership grammar for taxonomy/tag/brand, the Channel Connectors and plugin-partners epics, Shopify OAuth onboarding.

## Suggested next

- Verify, commit and publish. `check-types` is 48 of 48 as of this standdown; run the full suite and `npm pack` the core tarball into a scratch project before `pnpm release` — the adopter report that started this work was entirely about published packages failing on a clean install while the monorepo was green.
- Publish advisory `GHSA-mm4g-8wwr-p62h` after the packages land, not before.
- Tell adopters to apply `0003_add-better-auth-1-7-columns.sql` and note that `carts` gains a nullable `checkout_claim_token` set by `pushSchema`; carts stuck in `checking_out` at deploy time hold no token and will not be released by a failing checkout.
- Then take **Unify "act on behalf of another customer"** — it is the last known functional gap from this security work, and it breaks cart-first POS for custom roles.

## Suggested skills

- `plandesk-standup` at session start — it reads this file.
- `plandesk-autonomy` + `plandesk-foreman` for the remaining scope work.
- `factory.md`, `protocol.md`, `routing.md` for the per-item contract. The result contract now requires a `sabotage` field: a dispatch that omitted it hid a suite where six of seven tests passed with the fix reverted.
