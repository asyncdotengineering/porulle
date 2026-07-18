# ADR 0001 — POS returns refund/payout lifecycle

- **Status:** Accepted (documents known gaps; mitigations deferred)
- **Date:** 2026-07-18
- **Context tag:** SEC-08 (holistic security review, finding R-07)

## Context

The POS returns flow lets staff accept a return against a prior order and refund
the customer. The money path is intentionally split across two authorities:

- **Refund amount is derived server-side, never taken from the client.** The
  create-return route (`buildReturnRoutes` → `POST /api/pos/returns` in
  `packages/plugins/plugin-pos/src/routes/returns.ts`) omits `refundAmount` from
  its input schema and computes the authoritative amounts via
  `orders.refundLines(...)`, which validates the lines belong to the caller's org
  and enforces per-line `quantity − refundedQuantity`. This is the sanctioned
  pattern (already hardened under SEC-08) and is **not** in question here.
- **The cash payout** to the customer is a separate step —
  `paymentService.addPayment(orgId, returnId, …)` (the "add refund payment"
  route) — recorded against the return after it is created.

Splitting "compute + commit the refund" from "disburse the cash" is what creates
the two lifecycle gaps below. Both are **integrity/consistency** gaps, not
cross-tenant or amount-tampering vulnerabilities (those are closed by
`refundLines`).

## The gaps

### Gap 1 — refund committed at return-create, before the cash payout

`orders.refundLines` updates the order's refund ledger when the return is
**created**, but the physical cash payout (`addPayment`) is a later, separate
call. If the register flow is abandoned between the two — crash, staff walks
away, network drop — the order shows the amount as **refunded** while the
customer was never actually paid (or the reverse, depending on ordering). There
is no single transaction or saga spanning "ledger refund" and "cash disbursed",
so the two can diverge.

### Gap 2 — cross-channel double payout (online capture → POS cash refund)

An order **captured online** (card/gateway) that is returned **at the POS** can
be refunded on **both** rails: an online refund back to the original gateway
**and** a cash payout at the register. Nothing in the return path asserts that
the refund rail matches the original capture rail, so a cross-channel return can
pay the customer twice for the same line.

## Decision

Document these as **known, accepted lifecycle gaps** for now rather than block on
a full fix. Rationale: neither is an external exploit (amounts and org scope are
already enforced by `refundLines`); both require operator error or an abandoned
in-person flow to manifest; and the correct fix is a non-trivial money-movement
saga that should be designed deliberately, not patched under a hardening pass.

## Consequences / mitigations (future work)

- **Gap 1:** model the return refund + payout as a single durable saga (or a
  two-phase "pending → disbursed" state on the return), so an abandoned flow
  leaves the ledger un-refunded (or clearly `pending`) rather than falsely
  `refunded`. Reconciliation should surface returns stuck between the two states.
- **Gap 2:** record the original capture rail on the order and have the return
  path **select one refund rail** (prefer refunding the original online capture;
  fall back to cash only for cash-captured orders), rejecting a second rail for
  the same lines.
- Until then: operationally, POS refund-payout should be treated as a single
  manual step, and cross-channel (online-captured) returns should be routed to
  the online refund path, not the register.

Referenced code: `plugin-pos/src/routes/returns.ts` (`buildReturnRoutes`),
`plugin-pos/src/services/return-service.ts` (`ReturnService`),
`plugin-pos/src/services/payment-service.ts` (`PaymentService.addPayment`),
`orders` service `refundLines`.
