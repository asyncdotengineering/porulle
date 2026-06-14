# Day-one principles for Porulle apps

Five rules that prevent the most common Porulle-app foot-guns. Each is rooted
in a real bug class and points at the Porulle primitive that supports it. Adopt
them on day one — retrofitting them after the bugs ship is far more expensive.

---

## 1. No `as` casts on request bodies

`const body = (await c.req.json()) as T` looks type-safe but does **zero**
runtime validation — malformed or hostile bodies flow straight into your
handler, 500-ing or silently inserting garbage instead of returning a clean
422.

**Do this instead** — every body flows through [`parseJson`](#) (from
`@porulle/core`):

```ts
import { parseJson } from "@porulle/core";

app.post("/api/things", async (c) => {
  const body = await parseJson(c, MyThingBodySchema);
  if (body instanceof Response) return body; // 422 with details.issues[]
  // body is z.infer<typeof MyThingBodySchema>, validated.
});
```

Ship the [cast-ban guard](#cast-ban-guard-script) below in CI so regressions
can't creep back in.

## 2. Every state-changing 2xx writes an audit row

Audit-on-mutation must be the default, not something each handler remembers.
Forgetting it on one new route is how a privilege bypass ends up with no trail.

**Do this instead** — mount [`auditMiddleware`](#) once:

```ts
import { auditMiddleware } from "@porulle/core";

app.use("*", auditMiddleware(kernel));
```

It writes exactly one `commerce_audit_log` row per successful (2xx)
`POST`/`PUT`/`PATCH`/`DELETE`. Override the derived event/entity via
`c.set("auditEvent", ...)`, `c.set("auditEntityId", ...)`, etc.; opt a route
out with `c.set("auditSkip", true)`. Reads never write a row.

## 3. No silent money clamping

Validate sums, discounts, and refunds **at input** and return a 422 with an
explicit error code. A downstream "payment-sum mismatch" check is
defence-in-depth, not the primary signal — clamping a bad number to a "safe"
value hides the bug and corrupts the money.

```ts
if (refundAmount > order.capturable) {
  return err(c, 422, "REFUND_EXCEEDS_CAPTURE", "Refund exceeds captured amount.");
}
```

## 4. Tests assert contracts, not current implementations

A test name should read true forever, even after the internals are rewritten.

- ❌ `"manager actor refund succeeds"` — encodes the implementation.
- ✅ `"refund > cap WITHOUT manager override → 403"` — encodes the contract.

Assert on observable outcomes (HTTP status, response body, audit row), never on
internal state. A good test survives a radical refactor; a bad one breaks the
moment you move a function.

## 5. Single error envelope, field-mappable

Every error is `{ error: { code, message, details? } }`. Validation failures
(422) carry `details.issues[]`. Forms bind without ad-hoc parsing via the SDK
helper:

```ts
import { mapApiErrorToFields } from "@porulle/sdk";

const { data, error } = await api.POST("/api/things", { body });
if (error) {
  const { fieldErrors, formError } = mapApiErrorToFields(error);
  // fieldErrors["name"] = "must not be empty"
}
```

`parseJson` populates `details.issues[]` for you; `err(c, status, code, message,
details?)` builds the envelope everywhere else.

---

## Cast-ban guard script

Drop this into your workspace (e.g. `scripts/check-no-body-casts.ts`) and run it
in CI. It fails the build if any route casts a parsed body instead of validating
it.

```ts
#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.argv[2] ?? "src";
// Matches `c.req.json()) as Something` and `await c.req.json() as Something`.
const BANNED = /req\.json\(\)\)?\s+as\s+\w/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(full);
    } else if ([".ts", ".tsx"].includes(extname(full))) {
      yield full;
    }
  }
}

const offenders: string[] = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (BANNED.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  console.error("Unvalidated request-body casts found — use parseJson(c, schema):\n");
  console.error(offenders.join("\n"));
  process.exit(1);
}
console.log("✓ No unvalidated request-body casts.");
```

```jsonc
// package.json
{ "scripts": { "check:no-casts": "tsx scripts/check-no-body-casts.ts src" } }
```
