# Migrating from @porulle/core 0.13.0 to 0.14.0

A small release. One change can stop a server starting; the rest are additive.

Budget ten minutes. If you already set `auth.defaultOrganizationId` or
`auth.storeResolver`, there is probably nothing to do.

---

## 1. The server now refuses to start when it cannot resolve an organization

**This is the only change that can break a deployment.**

Strict organization resolution has defaulted to on since 0.13.0. What changed is
*when* you find out: a deployment configuring neither `auth.defaultOrganizationId`
nor `auth.storeResolver` used to boot cleanly and then return
`503 ORG_RESOLUTION_FAILED` on the first request carrying no actor. It now
refuses to construct.

That is deliberate. The old behaviour surfaced a configuration mistake as a
production incident, on a request path you may never exercise yourself — an
admin API whose calls all carry a token can look healthy for weeks and fail the
first time a real visitor arrives.

The error names every remedy:

```
Cannot resolve an organization for a request with no actor. Set
auth.defaultOrganizationId for a single-tenant deployment, or auth.storeResolver
for a multi-tenant one. To keep the previous permissive behaviour during a
migration, set auth.strictOrgResolution: false (or STRICT_ORG_RESOLUTION=false).
```

**Check your environment variables, not just your config.** An empty or
whitespace-only `defaultOrganizationId` counts as absent, because that is what an
unset variable produces:

```ts
// This is "unconfigured" if PORULLE_ORG_ID is unset or blank.
auth: { defaultOrganizationId: process.env.PORULLE_ORG_ID }
```

If that variable is missing from your `.env.example`, add it — a clean checkout
following your own documented setup is the case this catches.

To stage the upgrade, set `auth.strictOrgResolution: false` temporarily, then
remove it once tenancy is configured properly.

---

## 2. Session reads have their own rate-limit budget

`GET /api/auth/get-session` no longer shares the `/api/auth/*` bucket with the
credential endpoints. It uses `rateLimits.session`, defaulting to 120 per minute,
and is skipped by the shared limiter so one request is never counted twice.

Nothing to do — but **if you raised `rateLimits.auth` to stop operators being
signed out while navigating, you can put it back.** That was the workaround this
removes:

```ts
// Before — widening the credential budget to survive session polling
rateLimits: { auth: 200 }

// After — the credential budget returns to its default; sessions have their own
rateLimits: { session: 300 }   // only if 120/min is not enough
```

`rateLimits.signInPerEmail` is unchanged. It remains the primary credential
control and should not be widened.

---

## 3. `pgSearchAdapter()` no longer needs a `query` callback

It defaults to the database porulle is already connected to:

```ts
// Before — a second connection pool against the same database
const pgClient = postgres(connectionString);
search: {
  adapter: pgSearchAdapter({
    query: async (sql, params) => {
      const rows = await pgClient.unsafe(sql, params);
      return { rows };
    },
  }),
}

// After
search: { adapter: pgSearchAdapter() }
```

The old call still works and takes precedence — pass `query` when search should
run against a *different* database. If you only had that callback to satisfy the
required option, delete it and the extra client with it.

---

## 4. `resolveActor` is exported

For code outside the request pipeline — a server function, a script, a job — that
needs a porulle `Actor` rather than re-deriving organization and permissions by
hand:

```ts
import { resolveActor } from "@porulle/core";

const actor = await resolveActor(request.headers, auth, config);
if (!actor) return redirectToSignIn();
```

Returns `null` for an absent, malformed or expired session rather than throwing.
`AUTH_COOKIE_PREFIX` and `SESSION_COOKIE_NAME` are exported alongside it.

Worth knowing if you hand-rolled session handling: resolving a *session* never
needed a porulle helper. better-auth provides `auth.api.getSession({ headers })`
in-process and `createAuthClient` from `better-auth/client` for a separate
frontend. Only the session → `Actor` step was missing.

---

## 5. Custom tables need an `organizationId` column

Not a code change — a correction to guidance that was wrong.

Porulle scopes a custom table to a tenant by looking for an `organizationId`
column. A table without one is invisible to that machinery, so every row is
readable by every organization. The `Custom Tables` documentation previously
showed an example schema with no such column.

**Audit any table you added by following that page.** If it holds per-merchant
data and has no `organizationId`, it is not isolated:

```ts
organizationId: text("organization_id")
  .notNull()
  .references(() => organization.id, { onDelete: "cascade" }),
```

Backfilling one on a table with existing rows needs a decision about what those
rows belong to, so do it deliberately rather than with a default.

Also note which handle you hold: `config.routes` receives the **unscoped** kernel
database and does no filtering for you, while a plugin's `ctx.database.db` is
scoped per request. And raw `db.execute()` is never scoped on either — filter by
organization yourself in raw SQL.

---

## Upgrade checklist

- [ ] Confirm `auth.defaultOrganizationId` or `auth.storeResolver` is set — and that the env var behind it is actually populated.
- [ ] Boot the server. It fails fast now if tenancy is unresolvable.
- [ ] Drop any `rateLimits.auth` override that existed only to survive session polling.
- [ ] Simplify `pgSearchAdapter({ query })` to `pgSearchAdapter()` unless search uses a separate database.
- [ ] Audit custom tables for a missing `organizationId` column.

## Rolling back

0.14.0 adds no columns and no migrations. `0.13.x` runs against the same
database unchanged.
