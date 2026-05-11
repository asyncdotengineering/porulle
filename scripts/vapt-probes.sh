#!/usr/bin/env bash
# Live VAPT probe matrix against the deployed instance.
# Each probe is independent — failures don't abort the run.

set -u

BASE="${BASE:-https://unified-commerce-vapt.fly.dev}"
ORG_A_PRODUCT="c368f01c-74ee-4595-b884-ec5127fe72c3"
ORG_B_PRODUCT="f34b4264-1a99-46f5-8fdf-6c379035638e"

pass=0
fail=0

probe() {
  local name="$1" expected_re="$2" actual="$3"
  if [[ "$actual" =~ ^($expected_re)$ ]]; then
    echo "  PASS  $name  ($actual)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name  expected=~$expected_re actual=$actual"
    fail=$((fail + 1))
  fi
}

status() {
  curl -sS -o /dev/null -w "%{http_code}" "$@"
}

# ──────────────────────────────────────────────────────────────────
echo "=== 1. Anonymous mutation gates (auth before action) ==="
JSON_PRODUCT='{"type":"product","slug":"vapt-anon","attributes":{"title":"a"},"metadata":{}}'

probe "POST /api/mcp anonymous → 401" "401" "$(status -X POST $BASE/api/mcp -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1}")"
probe "POST /api/catalog/entities anonymous → 401|403" "401|403" "$(status -X POST $BASE/api/catalog/entities -H 'content-type: application/json' --data "$JSON_PRODUCT")"
probe "DELETE /api/catalog/entities/:id anonymous → 401|403" "401|403" "$(status -X DELETE $BASE/api/catalog/entities/$ORG_A_PRODUCT)"
probe "PATCH /api/catalog/entities/:id anonymous → 401|403" "401|403" "$(status -X PATCH $BASE/api/catalog/entities/$ORG_A_PRODUCT -H 'content-type: application/json' --data '{"slug":"hijack"}')"
probe "POST /api/inventory/adjust anonymous → 401|403|422" "401|403|422" "$(status -X POST $BASE/api/inventory/adjust -H 'content-type: application/json' --data '{"warehouseId":"00000000-0000-0000-0000-000000000000","entityId":"x","delta":1}')"
probe "DELETE /api/webhooks/:id anonymous → 401|403" "401|403" "$(status -X DELETE $BASE/api/webhooks/00000000-0000-0000-0000-000000000000)"
probe "GET /api/webhooks anonymous → 401|403" "401|403" "$(status $BASE/api/webhooks)"

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 2. Public read endpoints (200 OK, never 500) ==="
probe "GET /health → 200" "200" "$(status $BASE/health)"
probe "GET /api/auth/get-session anonymous → 200" "200" "$(status $BASE/api/auth/get-session)"
probe "GET /api/search?q=test → 200|429" "200|429" "$(status "$BASE/api/search?q=test")"

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 3. Malformed input → 400 (never 500 — would page on-call) ==="
probe "POST /api/mcp malformed JSON → 400|401" "400|401" "$(status -X POST $BASE/api/mcp -H 'content-type: application/json' --data 'not-json{')"
probe "POST /api/catalog/entities malformed JSON → 400|401|403" "400|401|403" "$(status -X POST $BASE/api/catalog/entities -H 'content-type: application/json' --data 'not-json{')"
probe "GET /api/search no query → 200|400|429" "200|400|429" "$(status "$BASE/api/search")"

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 4. Headers / middleware sanity ==="
hdrs=$(curl -sS -i -X POST $BASE/api/mcp -H 'content-type: application/json' --data '{}' 2>&1)
echo "$hdrs" | grep -qi "x-frame-options: DENY" && { echo "  PASS  X-Frame-Options: DENY"; pass=$((pass+1)); } || { echo "  FAIL  X-Frame-Options missing"; fail=$((fail+1)); }
echo "$hdrs" | grep -qi "x-content-type-options: nosniff" && { echo "  PASS  X-Content-Type-Options: nosniff"; pass=$((pass+1)); } || { echo "  FAIL  X-Content-Type-Options missing"; fail=$((fail+1)); }
echo "$hdrs" | grep -qi "strict-transport-security" && { echo "  PASS  Strict-Transport-Security present"; pass=$((pass+1)); } || { echo "  FAIL  HSTS missing"; fail=$((fail+1)); }
echo "$hdrs" | grep -qi "ratelimit-limit" && { echo "  PASS  Rate limit headers present"; pass=$((pass+1)); } || { echo "  FAIL  Rate limit headers missing"; fail=$((fail+1)); }

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 5. CORS / trusted origin enforcement ==="
cors=$(curl -sS -i -H "Origin: https://evil.example.com" $BASE/api/auth/get-session 2>&1 | grep -i "access-control-allow-origin" | tr -d '\r' || echo "(no ACAO)")
[[ "$cors" != *"evil.example.com"* ]] && { echo "  PASS  evil origin not echoed: $cors"; pass=$((pass+1)); } || { echo "  FAIL  evil origin reflected: $cors"; fail=$((fail+1)); }

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 6. Path traversal on storage / static ==="
probe "GET /assets/../../etc/passwd → 4xx" "404|400|403" "$(status "$BASE/assets/../../etc/passwd")"
probe "GET /assets/..%2F..%2Fetc%2Fpasswd → 4xx" "404|400|403" "$(status "$BASE/assets/..%2F..%2Fetc%2Fpasswd")"

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 7. SQL injection on search ==="
probe "GET /api/search?q='OR 1=1-- → 200|400|429 (not 500)" "200|400|429" "$(status "$BASE/api/search?q=%27OR%201%3D1--")"
probe "GET /api/search?q=<script> → 200|400|429 (not 500)" "200|400|429" "$(status "$BASE/api/search?q=%3Cscript%3E")"

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 8. Mass-assignment on signup (privilege escalation) ==="
mass_email="vapt-mass-$(date +%s)@vapt.test"
signup=$(curl -sS -X POST $BASE/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  --data "{\"email\":\"$mass_email\",\"password\":\"vapt-pass-1234\",\"name\":\"M\",\"role\":\"admin\",\"permissions\":[\"*:*\"]}" 2>&1)
echo "  signup: $(echo $signup | head -c 200)"
echo "$signup" | grep -q '"role":"admin"' && { echo "  FAIL  signup accepted role=admin"; fail=$((fail+1)); } || { echo "  PASS  signup did not accept role assignment"; pass=$((pass+1)); }

# ──────────────────────────────────────────────────────────────────
echo
echo "=== 9. Rate limit on /api/auth/* (10/min default) ==="
rl_429=0
for i in $(seq 1 15); do
  c=$(status $BASE/api/auth/get-session)
  [[ "$c" == "429" ]] && rl_429=$((rl_429 + 1))
done
[[ $rl_429 -gt 0 ]] && { echo "  PASS  $rl_429/15 hit 429 (rate limit active)"; pass=$((pass+1)); } || { echo "  FAIL  no 429s — rate limit not enforced"; fail=$((fail+1)); }

# ──────────────────────────────────────────────────────────────────
echo
echo "=== Summary ==="
echo "  Passes: $pass"
echo "  Fails:  $fail"
[[ $fail -eq 0 ]] && exit 0 || exit 1
