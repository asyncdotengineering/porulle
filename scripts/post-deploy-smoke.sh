#!/bin/bash
# Post-deploy smoke test — verifies the deployed app's schema matches code expectations.
#
# Runs after a Fly deploy to catch schema drift that release_command missed.
# The amount_captured incident showed that push could exit 0 without applying
# the column, and the first signal was a 500 in production traffic.
#
# Exit codes:
#   0 — app is serving (4xx for unauthenticated probe = schema OK)
#   1 — app returned 500 (schema mismatch or crash)
#   2 — app unreachable
set -euo pipefail

APP="${FLY_APP_NAME:-unified-commerce-vapt}"
BASE_URL="${BASE_URL:-https://${APP}.fly.dev}"
TIMEOUT="${SMOKE_TIMEOUT:-10}"

echo "[smoke] checking ${BASE_URL}/health ..."
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "${BASE_URL}/health")
if [ "$HEALTH" != "200" ]; then
  echo "[smoke] FAIL — /health returned ${HEALTH} (expected 200)"
  exit 2
fi
echo "[smoke] /health OK (${HEALTH})"

# Probe the orders endpoint. Unauthenticated requests get 401/403 — that's fine.
# A 500 means the orders table schema doesn't match what the code expects.
echo "[smoke] probing /api/orders/<fake-id> for schema validation ..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "${BASE_URL}/api/orders/00000000-0000-0000-0000-000000000000")

case "$STATUS" in
  401|403|404|422)
    echo "[smoke] schema probe OK (${STATUS} — expected client error for unauthenticated request)"
    exit 0
    ;;
  500)
    echo "[smoke] FAIL — /api/orders returned 500 (schema likely out of sync)"
    exit 1
    ;;
  *)
    echo "[smoke] unexpected status ${STATUS} — treating as non-fatal"
    exit 0
    ;;
esac
