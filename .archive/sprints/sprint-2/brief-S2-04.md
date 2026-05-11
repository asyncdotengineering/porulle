# Story Brief — `S2-04` `process.exit` edge-runtime guard

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S2-04] process.on handlers guarded for edge runtimes`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s2-04-edge-runtime.done`.

---

## 1. Goal

Fix LB-6: `runtime/server.ts` registers `process.on("unhandledRejection", () => process.exit(1))` and `process.on("uncaughtException", ...)`. In Cloudflare Workers (which the README claims to support), `process` is undefined and these calls throw at boot.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-6.
2. `packages/core/src/runtime/server.ts` lines 70–90 — the two `process.on` blocks.
3. The README's runtime claims — search for "Cloudflare Workers" and "edge".

---

## 3. Approach

Wrap both handler registrations in a runtime guard:

```typescript
// Before:
process.on("unhandledRejection", (reason) => { ... });
process.on("uncaughtException", (err) => { ... });

// After:
const isNodeRuntime = typeof process !== "undefined" 
  && typeof process.on === "function" 
  && typeof process.exit === "function";

if (isNodeRuntime) {
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection -- exiting");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception -- exiting");
    process.exit(1);
  });
}
```

Edge runtimes get a no-op. Node/Bun get the existing fail-fast.

Optional: log once at boot in non-Node runtimes ("running on edge runtime — process crash handlers skipped"). This is informational.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/runtime/server.ts` — wrap the `process.on` block in `isNodeRuntime` check.

**Create:**
- `packages/core/test/server-edge-runtime.test.ts`:
  - Mock `globalThis.process = undefined` (or a process-like object without `on`/`exit`).
  - Call `createServer(config)`.
  - Assert: no throw at server construction.
  - Restore `process` after.

**Do not touch:**
- The handler bodies (the actual logging/exit logic) — those run unchanged on Node.
- Any other lifecycle hook (graceful shutdown, etc.).

---

## 5. Acceptance criteria

1. `process.on(...)` registrations only fire when `typeof process.on === "function"` AND `typeof process.exit === "function"`.
2. Test confirms server boots without throwing when `process` is unavailable.
3. No `as any`, no `@ts-ignore`. (TypeScript may need `globalThis.process` typed as `unknown` for the runtime check — that's fine; use `typeof` checks, not `any`.)
4. Existing Node behavior (fail-fast on unhandled rejections) is preserved.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S2-04] process.on handlers guarded for edge runtimes`.
- [ ] Sentinel `.handoff/result-s2-04-edge-runtime.done`.

---

## 7. What NOT to do

- Do NOT silently swallow unhandled rejections in edge runtimes — let them propagate to the runtime's own handler.
- Do NOT introduce a polyfill of `process.on` for edge runtimes — defer to platform.
- Do NOT change graceful shutdown logic.
