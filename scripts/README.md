# scripts/

Operational scripts for the UnifiedCommerce Engine monorepo.

## db-release.sh

Used as the Fly `release_command` — applies pending Drizzle migrations before a new release rolls out. Falls back to `drizzle-kit push --force` for databases previously managed by push that lack a migration journal.

## post-deploy-smoke.sh

Post-deploy smoke test. Verifies the deployed app's schema matches code expectations by probing the orders endpoint. Returns 0 on success (4xx for unauthenticated = schema OK), 1 on 500 (schema drift), 2 if unreachable.

```bash
# Run manually against a deployment:
FLY_APP_NAME=unified-commerce-vapt bash scripts/post-deploy-smoke.sh
```

## db:check-drift

Detects schema drift between Drizzle schema definitions and generated migrations. Run via `pnpm run db:check-drift` from the repo root. CI runs this on PRs that touch `**/schema.ts`.

## vapt-probes.sh / ecommerce-vapt.sh

VAPT (Vulnerability Assessment and Penetration Testing) probe scripts. Used during security audit rounds.
