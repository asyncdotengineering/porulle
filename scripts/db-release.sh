#!/bin/bash
# Applies pending Drizzle migrations before a Fly release.
#
# Primary path: drizzle-kit migrate (deterministic, versioned SQL files).
# Fallback path: drizzle-kit push --force (introspects live schema, applies
# only the diff). The fallback handles DBs previously managed by push that
# lack a __drizzle_migrations journal — migrate fails on those because it
# tries to re-apply historical migrations against existing tables.
#
# To transition a push-managed DB to migrate-only:
#   1. Run scripts/db-bootstrap-journal.sh once against the target DB.
#   2. Subsequent deploys will use migrate without the push fallback.
set -euo pipefail

CONFIG="drizzle.config.ts"

echo "[db-release] running drizzle-kit migrate..."
if bunx drizzle-kit migrate --config "$CONFIG" --verbose 2>&1; then
  echo "[db-release] migrate succeeded."
  exit 0
fi

echo "[db-release] migrate failed — falling back to push for push-managed DB."
bunx drizzle-kit push --config "$CONFIG" --force --verbose
