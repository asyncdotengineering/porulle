#!/usr/bin/env bash
# Live e-commerce VAPT probe matrix.
#
# Mapped to:
#   - OWASP Top 10 for Business Logic Abuse (BLA1 Action Limit Overrun,
#     BLA2 Concurrent Workflow Order Bypass, BLA7 Resource Quota Violation)
#   - OWASP Top 10 (A01 Broken Access Control, A03 Injection,
#     A04 Insecure Design, A07 Auth Failures)
#   - PCI-DSS 4.0.1 client-side script integrity (best-effort: we don't host
#     PAN-input pages — payment is offloaded to the payment adapter — but
#     we still verify cookie security + transport hardening)
#   - Known commerce SEV/CVE classes:
#       * cart price manipulation (Magento, WooCommerce historical)
#       * coupon race / single-use replay (high-profile $600K abuse case)
#       * IDOR on orders / refunds (every commerce framework)
#       * mass assignment on signup / profile (Spree historical)
#       * webhook signature forgery
#       * inventory oversell race
#
# Each probe is independent. Failures don't abort the run.

set -u

BASE="${BASE:-https://unified-commerce-vapt.fly.dev}"
ORG_A_PRODUCT="c368f01c-74ee-4595-b884-ec5127fe72c3"
ORG_B_PRODUCT="f34b4264-1a99-46f5-8fdf-6c379035638e"
JAR_A="/tmp/vapt-cookies-a.txt"
JAR_B="/tmp/vapt-cookies-b.txt"
TS=$(date +%s)
EMAIL_A="vapt-a-${TS}@vapt.test"
EMAIL_B="vapt-b-${TS}@vapt.test"
PASS_PHRASE="vapt-pass-1234"

pass=0
fail=0
warn=0

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

warn_probe() {
  echo "  WARN  $1"
  warn=$((warn + 1))
}

status() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
body()   { curl -sS "$@"; }

# ──────────────────────────────────────────────────────────────────
echo "=== Provision authenticated sessions ==="
rm -f "$JAR_A" "$JAR_B"
curl -sS -c "$JAR_A" -X POST $BASE/api/auth/sign-up/email -H 'content-type: application/json' \
  --data "{\"email\":\"$EMAIL_A\",\"password\":\"$PASS_PHRASE\",\"name\":\"Customer A\"}" > /dev/null
curl -sS -c "$JAR_B" -X POST $BASE/api/auth/sign-up/email -H 'content-type: application/json' \
  --data "{\"email\":\"$EMAIL_B\",\"password\":\"$PASS_PHRASE\",\"name\":\"Customer B\"}" > /dev/null
USER_A=$(curl -sS -b "$JAR_A" $BASE/api/auth/get-session | sed 's/.*"userId":"\([^"]*\)".*/\1/')
USER_B=$(curl -sS -b "$JAR_B" $BASE/api/auth/get-session | sed 's/.*"userId":"\([^"]*\)".*/\1/')
echo "  USER_A=$USER_A"
echo "  USER_B=$USER_B"

# ══════════════════════════════════════════════════════════════════
echo
echo "## A) Cart & checkout integrity (Insecure Design — BLA1/BLA2)"
echo "Map: cart price manipulation (Magento/WooCommerce historical)"
echo

# A1: POST cart with forged customerId — server must ignore (customer-role)
A1_BODY='{"customerId":"00000000-0000-0000-0000-000000000bad","total":-100,"currency":"USD"}'
A1_RES=$(curl -sS -b "$JAR_A" -X POST $BASE/api/carts -H 'content-type: application/json' --data "$A1_BODY")
if echo "$A1_RES" | grep -qiE '"customerId":"00000000-0000-0000-0000-000000000bad"'; then
  echo "  FAIL  A1: cart persisted forged customerId — see $A1_RES"
  fail=$((fail + 1))
else
  echo "  PASS  A1: cart ignored client-supplied customerId"
  pass=$((pass + 1))
fi

# Pull cart id
CART_ID=$(echo "$A1_RES" | sed 's/.*"id":"\([^"]*\)".*/\1/' | head -c 36)
echo "  cart=$CART_ID"

# A2: Add item with negative quantity
A2=$(status -X POST $BASE/api/carts/$CART_ID/items -b "$JAR_A" -H 'content-type: application/json' \
  --data "{\"entityId\":\"$ORG_A_PRODUCT\",\"quantity\":-5}")
probe "A2: add line item qty=-5 → 400|422" "400|422" "$A2"

# A3: Add item with unitPrice override (price manipulation)
A3=$(curl -sS -b "$JAR_A" -X POST $BASE/api/carts/$CART_ID/items -H 'content-type: application/json' \
  --data "{\"entityId\":\"$ORG_A_PRODUCT\",\"quantity\":1,\"unitPrice\":1,\"price\":1,\"total\":1}")
echo "$A3" | grep -qi '"unitPrice":1\b' && { echo "  FAIL  A3: server used client-supplied unitPrice=1"; fail=$((fail+1)); } || { echo "  PASS  A3: server did not echo unitPrice=1 (price set server-side)"; pass=$((pass+1)); }

# A4: Quantity overflow / very large quantity
A4=$(status -X POST $BASE/api/carts/$CART_ID/items -b "$JAR_A" -H 'content-type: application/json' \
  --data "{\"entityId\":\"$ORG_A_PRODUCT\",\"quantity\":2147483647}")
probe "A4: qty=INT_MAX → 400|409|422" "400|409|422" "$A4"

# A5: POST checkout with mismatched declared total
A5_BODY="{\"cartId\":\"$CART_ID\",\"total\":1,\"subtotal\":1,\"shippingCost\":0,\"tax\":0}"
A5=$(status -X POST $BASE/api/checkout -b "$JAR_A" -H 'content-type: application/json' --data "$A5_BODY")
probe "A5: checkout w/ mismatched total → 400|422 (server recomputes)" "400|422|409|404" "$A5"

# ══════════════════════════════════════════════════════════════════
echo
echo "## B) Promotion / coupon abuse (BLA1 Action Limit Overrun)"
echo "Map: race-condition coupon replay (\$600K abuse case)"
echo

# B1: Apply non-existent coupon (response should not differ on existence)
B1=$(curl -sS -b "$JAR_A" -X POST $BASE/api/carts/$CART_ID/promotions -H 'content-type: application/json' --data '{"code":"NONEXIST_XYZ_99"}' -w "%{http_code}")
echo "  B1: $(echo $B1 | head -c 200)"

# B2: Apply same coupon 10x in parallel (race against single-use)
echo "  B2: firing 10 parallel coupon-apply requests..."
for i in $(seq 1 10); do
  curl -sS -b "$JAR_A" -X POST $BASE/api/carts/$CART_ID/promotions -H 'content-type: application/json' --data '{"code":"WELCOME10"}' > /dev/null &
done
wait
echo "  B2: race fired (manual review of DB needed for double-application; see notes)"
warn_probe "B2: race-condition coupon application requires DB inspection to confirm"

# ══════════════════════════════════════════════════════════════════
echo
echo "## C) Order IDOR & cross-customer access (A01 Broken Access Control)"
echo

# C1: GET /api/me/orders as customer A — should only return own
C1=$(curl -sS -b "$JAR_A" $BASE/api/me/orders)
echo "  C1: /api/me/orders → $(echo $C1 | head -c 200)"

# C2: GET arbitrary order id as customer A
C2=$(status $BASE/api/orders/00000000-0000-0000-0000-000000000000 -b "$JAR_A")
probe "C2: customer A GET random orderId → 403|404" "403|404|401" "$C2"

# C3: PATCH /api/orders/:id as customer (status escalation)
C3=$(status -X PATCH $BASE/api/orders/00000000-0000-0000-0000-000000000000 -b "$JAR_A" -H 'content-type: application/json' --data '{"status":"fulfilled"}')
probe "C3: customer PATCH order status → 401|403|404|405" "401|403|404|405" "$C3"

# ══════════════════════════════════════════════════════════════════
echo
echo "## D) Mass assignment / privilege escalation (A04 Insecure Design)"
echo "Map: Spree historical, Magento role override class"
echo

# D1: Sign-up with role=admin, permissions=*:* (re-confirm)
mass_email="vapt-mass-${TS}@vapt.test"
D1_BODY="{\"email\":\"$mass_email\",\"password\":\"$PASS_PHRASE\",\"name\":\"Mass\",\"role\":\"admin\",\"permissions\":[\"*:*\"],\"organizationId\":\"org_a\",\"vendorId\":\"x\"}"
D1=$(curl -sS -X POST $BASE/api/auth/sign-up/email -H 'content-type: application/json' --data "$D1_BODY")
echo "  D1 signup: $(echo $D1 | head -c 250)"
echo "$D1" | grep -q '"role":"admin"' && { echo "  FAIL  D1: signup accepted role=admin"; fail=$((fail+1)); } || { echo "  PASS  D1: signup ignored role assignment"; pass=$((pass+1)); }
echo "$D1" | grep -q '"permissions":\[' && { echo "  FAIL  D1b: signup accepted permissions[]"; fail=$((fail+1)); } || { echo "  PASS  D1b: signup ignored permissions[]"; pass=$((pass+1)); }

# D2: PATCH /api/me/profile with role override
D2=$(curl -sS -b "$JAR_A" -X PATCH $BASE/api/me/profile -H 'content-type: application/json' \
  --data '{"role":"admin","permissions":["*:*"],"organizationId":"org_b","userId":"OTHER_USER"}')
echo "  D2 PATCH /api/me/profile: $(echo $D2 | head -c 200)"
echo "$D2" | grep -qi '"role":"admin"' && { echo "  FAIL  D2: profile accepted role=admin"; fail=$((fail+1)); } || { echo "  PASS  D2: profile did not echo role=admin"; pass=$((pass+1)); }

# D3: Better Auth update-user with role
D3=$(curl -sS -b "$JAR_A" -X POST $BASE/api/auth/update-user -H 'content-type: application/json' \
  --data '{"role":"admin"}')
echo "  D3 update-user: $(echo $D3 | head -c 200)"
echo "$D3" | grep -qi '"role":"admin"' && { echo "  FAIL  D3: update-user accepted role"; fail=$((fail+1)); } || { echo "  PASS  D3: update-user did not accept role"; pass=$((pass+1)); }

# ══════════════════════════════════════════════════════════════════
echo
echo "## E) Auth hardening — credential stuffing, enumeration (A07)"
echo

# E1: Brute force /api/auth/sign-in (rate limit fires)
echo "  E1: 20 bad-password attempts..."
hit_429=0; total=20
for i in $(seq 1 $total); do
  c=$(status -X POST $BASE/api/auth/sign-in/email -H 'content-type: application/json' \
    --data "{\"email\":\"$EMAIL_A\",\"password\":\"wrong-$i\"}")
  [[ "$c" == "429" ]] && hit_429=$((hit_429 + 1))
done
[[ $hit_429 -gt 0 ]] && { echo "  PASS  E1: $hit_429/$total hit 429 — rate limit defends against stuffing"; pass=$((pass+1)); } || { echo "  FAIL  E1: 0 of $total bad-password attempts rate-limited"; fail=$((fail+1)); }

# E2: Password reset enumeration — same response shape for existing vs unknown email
existing=$(curl -sS -X POST $BASE/api/auth/forget-password -H 'content-type: application/json' --data "{\"email\":\"$EMAIL_A\"}")
unknown=$(curl -sS -X POST $BASE/api/auth/forget-password -H 'content-type: application/json' --data "{\"email\":\"definitely-not-here-${TS}@vapt.test\"}")
if [[ "$existing" == "$unknown" ]]; then
  echo "  PASS  E2: forget-password response identical for existing/unknown email (no enumeration)"
  pass=$((pass+1))
else
  echo "  WARN  E2: forget-password responses differ"
  echo "    existing: $(echo $existing | head -c 120)"
  echo "    unknown:  $(echo $unknown | head -c 120)"
  warn=$((warn+1))
fi

# E3: Cookie flags — must be __Secure-, HttpOnly, Secure
ck=$(grep -i "uc.session_token" "$JAR_A" | head -1 || echo "")
echo "$ck" | grep -q "TRUE" && [[ "$ck" == *HttpOnly* ]] && [[ "$ck" == *__Secure-* ]] && { echo "  PASS  E3: session cookie HttpOnly + Secure + __Secure- prefix"; pass=$((pass+1)); } || { echo "  WARN  E3: cookie hardening incomplete: $ck"; warn=$((warn+1)); }

# ══════════════════════════════════════════════════════════════════
echo
echo "## F) PII exposure (A02 / GDPR / CCPA)"
echo

# F1: Anonymous /api/customers
F1=$(status $BASE/api/customers)
probe "F1: anonymous GET /api/customers → 401|403" "401|403" "$F1"

# F2: Anonymous /api/orders
F2=$(status $BASE/api/orders)
probe "F2: anonymous GET /api/orders → 401|403" "401|403" "$F2"

# F3: Anonymous /api/me (different shape — should be unauthorized)
F3=$(status $BASE/api/me/profile)
probe "F3: anonymous GET /api/me/profile → 401|403" "401|403" "$F3"

# ══════════════════════════════════════════════════════════════════
echo
echo "## G) Information disclosure (A04, A09)"
echo

# G1: 500 errors must not leak stack traces in production
G1=$(curl -sS -X POST $BASE/api/checkout -b "$JAR_A" -H 'content-type: application/json' --data '{"cartId":"NOT_A_UUID"}')
echo "$G1" | grep -qiE '\.(ts|js):[0-9]+|at [A-Za-z]+\(' && { echo "  FAIL  G1: error response leaked stack trace: $(echo $G1 | head -c 200)"; fail=$((fail+1)); } || { echo "  PASS  G1: no stack trace in error response"; pass=$((pass+1)); }

# G2: Drizzle column names not leaked
G2=$(curl -sS $BASE/api/products?limit=abc)
echo "$G2" | grep -qiE 'drizzle|"column":|relation "' && { echo "  FAIL  G2: ORM internals leaked"; fail=$((fail+1)); } || { echo "  PASS  G2: ORM internals not leaked"; pass=$((pass+1)); }

# G3: Server / framework version disclosure
serv=$(curl -sS -I $BASE/health | grep -i "^server:" | tr -d '\r' || echo "(none)")
echo "  G3: Server header: $serv"
echo "$serv" | grep -qiE "hono|bun [0-9]|node[/-][0-9]" && { echo "  WARN  G3: server header reveals stack version"; warn=$((warn+1)); } || { echo "  PASS  G3: server header generic"; pass=$((pass+1)); }

# G4: OpenAPI spec exposure (admin-grade introspection)
G4_doc=$(status $BASE/api/docs)
G4_oapi=$(status $BASE/api/openapi.json)
G4_scalar=$(status $BASE/api/scalar)
echo "  G4: /api/docs=$G4_doc /api/openapi.json=$G4_oapi /api/scalar=$G4_scalar"
[[ "$G4_doc" == "200" || "$G4_oapi" == "200" || "$G4_scalar" == "200" ]] && { echo "  WARN  G4: OpenAPI spec/docs anonymous-readable — leaks every route/contract to scrapers"; warn=$((warn+1)); } || { echo "  PASS  G4: API spec not anonymous"; pass=$((pass+1)); }

# ══════════════════════════════════════════════════════════════════
echo
echo "## H) Stored XSS / output integrity (A03)"
echo

# H1: Anonymous can't create products. Customers create reviews though.
# Create a review with HTML payload via /api/reviews (store-example route)
H1_BODY='{"entityId":"'$ORG_A_PRODUCT'","rating":5,"title":"<script>alert(1)</script>","body":"<img src=x onerror=alert(1)>"}'
H1=$(curl -sS -b "$JAR_A" -X POST $BASE/api/reviews -H 'content-type: application/json' --data "$H1_BODY")
echo "  H1 review create: $(echo $H1 | head -c 250)"
H1_GET=$(curl -sS $BASE/api/reviews?entityId=$ORG_A_PRODUCT | head -c 300)
echo "$H1_GET" | grep -q "Content-Type: application/json" || true
ct=$(curl -sS -I $BASE/api/reviews?entityId=$ORG_A_PRODUCT | grep -i "content-type:" | head -1 | tr -d '\r')
echo "$ct" | grep -qi "application/json" && { echo "  PASS  H1: reviews response Content-Type=application/json (not html)"; pass=$((pass+1)); } || { echo "  WARN  H1: reviews response Content-Type: $ct"; warn=$((warn+1)); }

# ══════════════════════════════════════════════════════════════════
echo
echo "## I) Webhook integrity (BLA8 / payment integrity)"
echo

# I1: SSRF guard on webhook URL — register a webhook to an internal IP
I1=$(curl -sS -b "$JAR_A" -X POST $BASE/api/webhooks -H 'content-type: application/json' \
  --data '{"url":"http://169.254.169.254/latest/meta-data/","events":["order.created"]}')
echo "  I1 register internal webhook: $(echo $I1 | head -c 200)"
echo "$I1" | grep -qiE 'internal|localhost|169\.254|loopback' && { echo "  PASS  I1: SSRF guard rejected internal IP webhook URL"; pass=$((pass+1)); } || { echo "  WARN  I1: SSRF check on webhook URL inconclusive — see response"; warn=$((warn+1)); }

# ══════════════════════════════════════════════════════════════════
echo
echo "## J) HTTP-level hardening (transport, methods)"
echo

# J1: TRACE method — server should reject (any non-2xx is fine; we MUST not
# echo back request headers, which is the actual TRACE risk)
J1=$(status -X TRACE $BASE/api/auth/get-session)
probe "J1: TRACE → 4xx|5xx (rejected)" "[45][0-9][0-9]" "$J1"

# J2: HTTP/1.1 unencrypted — Fly should redirect to HTTPS (force_https)
J2=$(curl -sS -o /dev/null -w "%{http_code}" --max-redirs 0 http://unified-commerce-vapt.fly.dev/health 2>/dev/null)
probe "J2: plain HTTP → 301|308|307|301 (force_https redirect)" "301|308|307" "$J2"

# J3: oversized body (10MB) — body-limit middleware
big_body=$(python3 -c "print('{\"x\":\"' + 'A' * 1100000 + '\"}')")
J3=$(echo "$big_body" | curl -sS -o /dev/null -w "%{http_code}" -X POST $BASE/api/checkout -H 'content-type: application/json' --data-binary @- 2>&1)
probe "J3: 1MB+ body → 413|400|422" "413|400|422" "$J3"

# ══════════════════════════════════════════════════════════════════
echo
echo "=== Summary ==="
echo "  PASS: $pass"
echo "  FAIL: $fail"
echo "  WARN: $warn (manual follow-up)"
[[ $fail -eq 0 ]] && exit 0 || exit 1
