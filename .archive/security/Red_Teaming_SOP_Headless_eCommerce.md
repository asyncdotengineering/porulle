# RED TEAMING — STANDARD OPERATING PROCEDURE

## Security Assessment of Headless eCommerce Frameworks

**API-First, MACH, and Composable Commerce Architectures**

---

| Field | Detail |
|---|---|
| **Document Version** | 3.0 |
| **Classification** | **CONFIDENTIAL** |
| **Effective Date** | March 2026 |
| **Review Cycle** | Quarterly |

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Headless Commerce Threat Landscape](#2-headless-commerce-threat-landscape)
3. [Engagement Model and Rules of Engagement](#3-engagement-model-and-rules-of-engagement)
4. [Phase 1: Reconnaissance and Discovery](#4-phase-1-reconnaissance-and-discovery)
5. [Phase 2: API Security Testing](#5-phase-2-api-security-testing)
6. [Phase 3: Frontend and Client-Side Testing](#6-phase-3-frontend-and-client-side-testing)
7. [Phase 4: Business Logic and Payment Testing](#7-phase-4-business-logic-and-payment-testing)
8. [Phase 5: Infrastructure and Cloud Security](#8-phase-5-infrastructure-and-cloud-security)
9. [Phase 6: Third-Party and Supply Chain Assessment](#9-phase-6-third-party-and-supply-chain-assessment)
10. [Phase 7: Compliance and Data Privacy Validation](#10-phase-7-compliance-and-data-privacy-validation)
11. [Recommended Tooling](#11-recommended-tooling)
12. [Severity Classification Framework](#12-severity-classification-framework)
13. [Reporting and Deliverables](#13-reporting-and-deliverables)
14. [Post-Engagement Procedures](#14-post-engagement-procedures)
15. [Appendix A: Engagement Checklist](#appendix-a-engagement-checklist)
16. [Appendix B: Document Control](#appendix-b-document-control)

---

## 1. Purpose and Scope

This Standard Operating Procedure establishes a repeatable, risk-informed methodology for conducting red team security assessments against headless eCommerce frameworks. The SOP is designed for security teams tasked with evaluating API-first, MACH (Microservices, API-first, Cloud-native, Headless), and composable commerce architectures where the presentation layer is decoupled from the commerce backend.

### 1.1 Objective

The primary objective is to identify, validate, and prioritize exploitable security weaknesses across the full attack surface of headless eCommerce implementations before malicious actors can leverage them. This includes testing the API gateway, microservices, frontend applications, third-party integrations, payment flows, and supporting infrastructure.

### 1.2 Applicable Frameworks and Platforms

This SOP applies to red team engagements targeting any headless commerce deployment, including but not limited to the following representative platforms:

| SaaS Platforms | Open-Source | Composable / MACH | Supporting Layers |
|---|---|---|---|
| Shopify (Hydrogen/Oxygen) | Saleor (GraphQL) | Commercetools | Headless CMS (Contentful, Strapi, Sanity) |
| BigCommerce | Medusa.js | Elastic Path | Payment gateways |
| Salesforce Commerce Cloud | Adobe Commerce / Magento | Fabric | PIM / OMS systems |
| | Vendure | Spryker | |

### 1.3 Scope Boundaries

Every engagement must define explicit scope before testing begins. The scope document should delineate: target environment (production, staging, or QA), API versions included, frontend applications, third-party integrations, and any exclusions such as denial-of-service testing or physical penetration. Written authorization from the asset owner is mandatory before any active testing commences.

---

## 2. Headless Commerce Threat Landscape

Headless eCommerce architectures introduce a fundamentally different attack surface compared to monolithic platforms. By decoupling the frontend from the backend and exposing commerce functionality through APIs, organizations gain agility but simultaneously expand the number of entry points available to adversaries.

### 2.1 Expanded Attack Surface

Modern headless deployments often involve dozens of interconnected microservices for product catalog, cart, checkout, inventory, pricing, loyalty, and shipping. Each microservice exposes its own API endpoints, and each integration represents a potential entry point. The MACH approach—while enabling immense agility—demands a unified security posture; without centralized SecOps, the very integrations meant to drive growth can become vectors for sophisticated multi-stage attacks.

### 2.2 Key Threat Categories

| Threat Category | Description | Headless-Specific Impact |
|---|---|---|
| **API Abuse & Exploitation** | Broken authentication, BOLA/IDOR, mass assignment, and excessive data exposure across commerce APIs | Storefront APIs often run unauthenticated for guest browsing, widening exposure to scraping and enumeration |
| **Payment Flow Manipulation** | Digital skimming, price tampering, coupon/promo abuse, and checkout logic bypass | Decoupled checkout flows rely on client-side orchestration, enabling parameter tampering between frontend and payment API |
| **Authentication & Session** | Token theft, JWT manipulation, OAuth misconfig, credential stuffing, and session fixation | SPAs and mobile apps store tokens client-side; direct API authentication bypasses traditional server-side session controls |
| **Supply Chain & Third-Party** | Compromised dependencies, malicious plugins, vulnerable CMS integrations, and CDN poisoning | Composable stacks integrate 10–30+ vendors; a breach in one service can cascade across the ecosystem |
| **Business Logic Flaws** | Inventory manipulation, loyalty point abuse, BNPL fraud, cart race conditions, and referral scheme exploitation | Microservice boundaries can create inconsistent state, enabling race conditions between cart, inventory, and order services |
| **Infrastructure & Config** | Exposed admin panels, debug endpoints, misconfigured CORS, SSRF, and cloud misconfigurations | Multiple deployment artifacts (SSR server, CDN, API gateway, BFF) multiply configuration error opportunities |

> **⚠️ CRITICAL INDUSTRY DATA**
>
> Cyber incidents have maintained the top risk position globally at 42% of survey responses for five consecutive years per the 2026 Allianz Risk Barometer. Valid account credentials now represent 30% of attack vectors according to IBM X-Force, making customer account security in eCommerce operations paramount. The average US data breach cost reached $10.22 million in 2025, an all-time record.

---

## 3. Engagement Model and Rules of Engagement

### 3.1 Engagement Types

| Dimension | Black Box | Grey Box | White Box |
|---|---|---|---|
| **Knowledge Provided** | Target URLs only; no documentation, credentials, or source code | API documentation (Swagger/OpenAPI), limited credentials, architecture overview | Full source code, infrastructure diagrams, admin credentials, deployment configs |
| **Simulates** | External attacker with no prior knowledge | Compromised partner or insider with partial access | Malicious developer or full insider threat |
| **Recommended For** | Initial baseline assessment, compliance validation | Targeted API security review, most common headless engagement type | Pre-launch deep-dive, architecture security review |

### 3.2 Rules of Engagement Template

1. Obtain signed authorization and scope agreement from asset owner
2. Define communication channels: primary contact, escalation path, and emergency stop procedures
3. Establish testing windows: agree on permitted hours and any blackout periods
4. Specify data handling: all captured PII, tokens, and credentials must be encrypted at rest and purged post-engagement
5. Agree on notification thresholds: critical findings (e.g., active data exposure, RCE) must be reported within 4 hours
6. Document any rate-limiting or WAF whitelisting required for comprehensive testing
7. Confirm rollback procedures for any persistent changes made during testing

### 3.3 Team Composition

A typical headless commerce red team engagement requires a cross-functional skill set. The recommended team includes:

- **Red Team Lead** — Responsible for engagement management and final reporting
- **API Security Specialist(s)** — Expertise in REST, GraphQL, and gRPC testing
- **Frontend/SPA Security Analyst** — Skilled in JavaScript framework exploitation and client-side attacks
- **Cloud Infrastructure Specialist** — Familiar with the target's hosting environment (AWS, GCP, Azure, or platform-managed)
- **Business Logic Analyst** — Understands eCommerce workflows such as checkout, pricing, promotions, and fulfillment

---

## 4. Phase 1: Reconnaissance and Discovery

### 4.1 Passive Reconnaissance

Begin all engagements with passive information gathering that does not generate traffic to the target. The goal is to map the technology stack, identify exposed services, and enumerate the API surface before active probing begins.

#### 4.1.1 Technology Fingerprinting

- **Frontend Framework Detection:** Identify whether the storefront uses React (Next.js/Hydrogen), Vue (Nuxt.js), Angular, or Gatsby through HTTP response headers, JavaScript bundle analysis, and HTML source patterns.
- **Commerce Platform Identification:** Determine the backend platform by analyzing API response structures, cookie names, error message formats, and known endpoint patterns (e.g., `/graphql` for Saleor, `/api/storefront` for BigCommerce).
- **Infrastructure Mapping:** Enumerate CDN provider (Cloudflare, Fastly, Vercel Edge), hosting (Oxygen, Vercel, Netlify, AWS), and API gateway technology through DNS records, TLS certificates, and HTTP headers.
- **Third-Party Service Discovery:** Catalog payment gateways (Stripe, Adyen, Braintree), analytics providers, CMS platforms, and marketing tools through JavaScript source analysis, network traffic inspection, and Subresource Integrity (SRI) tag review.

#### 4.1.2 API Surface Enumeration

- **Documentation Discovery:** Search for exposed Swagger/OpenAPI specifications at common paths (`/swagger.json`, `/openapi.yaml`, `/api-docs`, `/v1/docs`). Check for GraphQL introspection at `/graphql` endpoints.
- **Endpoint Harvesting:** Extract API endpoints from JavaScript bundles, mobile app reverse engineering, `sitemap.xml`, `robots.txt`, and browser developer tools network inspection.
- **Version Discovery:** Probe for deprecated API versions (`/v1/`, `/v2/`, `/beta/`) that may lack current security controls.
- **OSINT Sources:** Review GitHub repositories for leaked API keys, Postman public workspaces for collection exports, and developer documentation sites for undocumented endpoints.

### 4.2 Active Reconnaissance

With passive data collected, proceed to active probing to validate findings and expand the attack surface map.

#### 4.2.1 Subdomain and Service Enumeration

- **Subdomain Discovery:** Use tools such as Amass, Subfinder, and certificate transparency logs (crt.sh) to discover subdomains that may host admin panels, staging environments, internal APIs, or microservice endpoints.
- **Port and Service Scanning:** Identify non-standard ports hosting API gateways, admin interfaces, or database management consoles. Focus on common headless commerce ports and services.
- **Cloud Asset Discovery:** Enumerate cloud storage buckets, serverless function endpoints, and container registries associated with the target organization.

#### 4.2.2 GraphQL-Specific Reconnaissance

Many headless commerce platforms (Saleor, Shopify Storefront API, Commercetools) expose GraphQL endpoints. GraphQL requires specialized reconnaissance techniques:

- **Introspection Query:** Attempt a full schema introspection query to map all types, queries, mutations, and subscriptions. Many production deployments fail to disable introspection.
- **Field Suggestion Exploitation:** Even with introspection disabled, GraphQL servers may return field suggestions in error messages. Use tools like Clairvoyance to reconstruct the schema.
- **Batch Query Analysis:** Test whether the endpoint supports query batching, which can be abused for credential brute-forcing or resource exhaustion.

---

## 5. Phase 2: API Security Testing

API testing is the core of any headless commerce red team engagement. The decoupled architecture means that every business operation—from browsing products to completing checkout—flows through API calls that must be individually scrutinized.

### 5.1 OWASP API Security Top 10 Coverage

All engagements must systematically test against the OWASP API Security Top 10 (2023 edition). The following table maps each risk to headless-commerce-specific test cases:

| OWASP API Risk | Headless Commerce Test Cases | Tools |
|---|---|---|
| **API1: Broken Object Level Authorization (BOLA)** | Modify order IDs, customer profile IDs, cart tokens, and wishlist references to access other users' data. Test across guest, authenticated, and admin scopes. | Burp Suite Autorize, custom Intruder payloads, IDOR Hunter |
| **API2: Broken Authentication** | Test token lifecycle (JWT alg:none, key confusion, expiry bypass). Evaluate OAuth flows for PKCE enforcement. Test Storefront API token reuse across sessions. | jwt_tool, Burp JWT extensions, OAuth Tester |
| **API3: Broken Object Property Level Authorization** | Submit additional properties in cart/order update requests (price, discount, shipping method). Test mass assignment on customer profile and address endpoints. | Burp Repeater, Param Miner, Arjun |
| **API4: Unrestricted Resource Consumption** | Send deeply nested GraphQL queries, oversized batch requests, or rapid product search queries to test rate limiting and resource controls. | GraphQL Cop, custom scripts, Turbo Intruder |
| **API5: Broken Function Level Authorization** | Attempt admin-level operations (order cancellation, price modification, inventory adjustment) with customer-level tokens. Test role escalation paths. | Autorize, manual endpoint fuzzing |
| **API6: Unrestricted Access to Sensitive Business Flows** | Automate checkout for limited-edition products (scalping). Script coupon brute-forcing. Automate fake account creation for promotional abuse. | Custom Python scripts, Selenium, Playwright |
| **API7: Server-Side Request Forgery (SSRF)** | Test webhook URL parameters, image upload processors, PDF generators, and CMS content preview endpoints for SSRF against internal cloud metadata services. | SSRFmap, Collaborator, custom payloads |
| **API8: Security Misconfiguration** | Audit CORS policies, CSP headers, verbose error messages, exposed debug endpoints, default credentials, and overly permissive API gateway configs. | SecurityHeaders.com, Nuclei, custom checks |
| **API9: Improper Inventory Management** | Discover deprecated API versions still active. Test for shadow APIs and undocumented admin endpoints. Check for exposed development/staging APIs. | Kiterunner, ffuf, API wordlists |
| **API10: Unsafe Consumption of APIs** | Evaluate trust boundaries with third-party APIs (payment processors, shipping providers, CMS). Test for injection through upstream API responses. | Burp Suite, custom middleware analysis |

### 5.2 Authentication and Session Management Testing

Headless architectures rely heavily on token-based authentication. The red team must evaluate:

- **JWT Implementation:** Test for algorithm confusion attacks (alg:none, RS256 to HS256 downgrade), insufficient signature validation, missing expiry enforcement, and information leakage through JWT claims.
- **OAuth 2.0 / OIDC Flows:** Validate that the Storefront API uses secure login flows based on standards like OpenID Connect and OAuth. Test for authorization code interception, PKCE bypass, and token leakage through referrer headers.
- **API Key Security:** Evaluate how API keys are scoped, rotated, and stored. Test whether Storefront API keys (often intended for public use) can be leveraged to access admin-scoped operations.
- **Session Token Storage:** Verify that mobile apps and SPAs do not store credentials or tokens in insecure locations such as localStorage, unencrypted SharedPreferences, or the device keychain without adequate protection.

### 5.3 GraphQL-Specific Attack Vectors

GraphQL endpoints in headless commerce require specialized testing beyond standard REST API methodology:

1. **Query Depth and Complexity Attacks:** Craft deeply nested queries (e.g., products → variants → reviews → author → orders) to test for denial-of-service through query complexity.
2. **Batch Query Abuse:** Test whether batched queries can be used to brute-force authentication, enumerate user accounts, or bypass per-request rate limits.
3. **Mutation Authorization:** Verify that mutations enforce proper authorization; test whether a customer-scoped token can execute admin mutations.
4. **Alias-Based Attacks:** Use GraphQL aliases to duplicate expensive operations within a single request, bypassing rate limits tied to request count.
5. **Introspection Data Leakage:** Analyze introspection results for sensitive type names, deprecated fields, and internal comments that reveal system architecture.

---

## 6. Phase 3: Frontend and Client-Side Testing

### 6.1 Single-Page Application (SPA) Security

Headless storefronts built with React, Vue, or Angular introduce client-side attack vectors that do not exist in traditional server-rendered commerce platforms.

- **JavaScript Bundle Analysis:** Decompile and analyze frontend bundles for hardcoded API keys, secrets, internal endpoint URLs, debugging flags, and commented-out authentication bypass logic.
- **Client-Side Routing Bypass:** Test whether client-side route guards can be bypassed to access admin panels, order management, or customer data pages without proper server-side authorization.
- **Cross-Site Scripting (XSS):** Test all user-controlled input fields (search, product reviews, address forms, custom attributes) for reflected, stored, and DOM-based XSS. Pay particular attention to product description rendering in headless CMS integrations.
- **Prototype Pollution:** Test JavaScript frameworks for prototype pollution vulnerabilities that can be chained with other flaws to achieve code execution or bypass security controls.

### 6.2 Server-Side Rendering (SSR) Considerations

Many headless storefronts use SSR frameworks like Next.js or Hydrogen for SEO and performance. SSR introduces server-side attack vectors:

- **SSR Injection:** Test for template injection or code injection through user-controlled data rendered on the server. The React Server Components vulnerability (CVE-2025-55182) demonstrated that serialized data in the Flight protocol handshake can enable remote code execution.
- **Environment Variable Exposure:** Verify that server-side environment variables (database credentials, payment API keys, admin secrets) are not leaked to client-side bundles during the SSR build process.
- **API Route Exploitation:** Test Next.js/Hydrogen API routes for injection flaws, improper access controls, and SSRF vulnerabilities in backend-for-frontend (BFF) middleware.

---

## 7. Phase 4: Business Logic and Payment Testing

> **⚠️ HIGH-PRIORITY AREA**
>
> Business logic flaws in eCommerce can cause direct financial loss. Studies indicate these vulnerabilities cost organizations an average of $8.64 million per incident. This phase requires deep understanding of the target's commerce workflows.

### 7.1 Checkout and Payment Flow Testing

1. **Price Manipulation:** Intercept API requests during checkout and modify product prices, shipping costs, tax calculations, and discount amounts at the API level before they reach the payment processor.
2. **Currency Mismatch:** Test multi-currency implementations for rounding errors, exchange rate manipulation, and currency code substitution attacks.
3. **Coupon and Promotion Abuse:** Test for coupon code brute-forcing, stacking exploits, expired coupon reuse, and boundary condition bypass (e.g., applying a $50-off coupon to a $49 order).
4. **Payment Method Switching:** Test whether changing the payment method mid-flow (e.g., from credit card to BNPL to gift card) introduces inconsistencies that can be exploited.
5. **Order Completion Manipulation:** Test whether orders can be marked as paid by replaying or forging payment confirmation webhooks from the payment gateway.

### 7.2 Inventory and Cart Manipulation

- **Race Conditions:** Use concurrent API requests to test whether multiple users can purchase the last item in stock, or whether cart-to-checkout transitions can be exploited with parallel requests.
- **Cart Persistence Attacks:** Test whether abandoned cart data (including payment tokens) can be accessed by other users or through predictable cart identifiers.
- **Quantity Manipulation:** Test negative quantity values, decimal quantities, integer overflow values, and zero-price items to identify input validation gaps in cart APIs.
- **Shipping Logic Bypass:** Test whether free shipping thresholds can be manipulated by adding and then removing high-value items after the shipping discount is applied.

### 7.3 Account and Identity Abuse

- **Account Takeover Chains:** Test for credential stuffing resilience, password reset flow manipulation, email/phone enumeration through registration and password reset APIs.
- **Loyalty and Rewards Abuse:** Test point transfer between accounts, negative balance exploitation, referral program gaming through automated account creation.
- **BNPL Fraud Vectors:** Test Buy Now, Pay Later integrations for identity spoofing, multiple-account exploitation, and order manipulation after BNPL approval.

---

## 8. Phase 5: Infrastructure and Cloud Security

### 8.1 API Gateway and WAF Testing

- **WAF Bypass Techniques:** Test request smuggling, encoding variations (double URL encoding, Unicode normalization), HTTP/2 downgrade attacks, and chunked transfer encoding to bypass WAF rules.
- **Rate Limit Evasion:** Test whether rate limits can be circumvented through IP rotation, header manipulation (X-Forwarded-For), API key rotation, or request distribution across API versions.
- **Gateway Misconfiguration:** Test for path traversal through the API gateway, unauthorized access to backend microservices by manipulating routing headers, and exposed management interfaces.

### 8.2 Microservice Security

In headless commerce, each microservice (product, cart, order, payment, customer, inventory) should be treated as a security checkpoint. The red team must evaluate:

- **Inter-Service Authentication:** Verify that service-to-service communication uses mutual TLS or signed tokens, not implicit trust based on network location.
- **Data Isolation:** Test whether compromising one microservice grants access to data owned by other services. Evaluate database segmentation and shared credential risks.
- **Container Security:** Assess container images for known vulnerabilities, excessive privileges, exposed management APIs (Docker API, Kubernetes Dashboard), and secrets embedded in image layers.

### 8.3 Cloud and CDN Configuration

- **Cloud Metadata SSRF:** Test all URL-accepting parameters for access to cloud instance metadata endpoints (`169.254.169.254` for AWS, `metadata.google.internal` for GCP).
- **Storage Bucket Permissions:** Enumerate and test S3 buckets, GCS buckets, and Azure blob storage for public read/write access, particularly those storing product images, exports, or backups.
- **CDN Cache Poisoning:** Test for web cache deception and cache poisoning attacks that could serve malicious content to all storefront visitors.
- **Edge Function Security:** If the storefront uses edge functions (Cloudflare Workers, Vercel Edge Functions), test for injection and authorization bypass in the edge layer.

---

## 9. Phase 6: Third-Party and Supply Chain Assessment

Headless commerce stacks are inherently composable, often integrating ten to thirty or more third-party vendors. Security experts identify third-party risk as one of the top attack vectors in eCommerce. The red team must assess:

### 9.1 Integration Security

- **Webhook Security:** Test all incoming webhooks (payment confirmations, shipping updates, CMS content sync) for signature verification, replay protection, and injection through webhook payloads.
- **CMS Integration:** Test headless CMS content rendering for stored XSS, SSRF through image/asset URLs, and content injection that could modify product information or prices.
- **Payment Gateway Integration:** Verify PCI DSS compliance boundaries. Test whether the integration properly tokenizes card data client-side without raw card numbers touching the commerce backend.
- **Plugin and Extension Audit:** Review installed plugins, themes, and extensions for known vulnerabilities. Verify that all components are running current, patched versions.

### 9.2 Dependency and Build Pipeline

- **NPM/Yarn Dependency Audit:** Run automated SCA (Software Composition Analysis) against the frontend dependency tree. Flag any packages with known CVEs or suspicious maintenance patterns.
- **CI/CD Pipeline Security:** If in scope, test the build pipeline for secrets exposure in build logs, unauthorized deployment triggers, and supply chain injection through compromised dependencies.
- **Subresource Integrity:** Verify that all externally loaded scripts use SRI hashes to prevent CDN compromise from injecting malicious code into the storefront.

---

## 10. Phase 7: Compliance and Data Privacy Validation

### 10.1 PCI DSS Alignment

All payment-related testing should validate alignment with PCI DSS requirements. Key areas include: secure transmission of cardholder data, proper tokenization boundaries, access control to payment-processing microservices, and audit logging of payment transactions. Verify that the headless frontend never handles raw card data directly.

### 10.2 Privacy Regulation Compliance

Test data handling against applicable privacy regulations. For GDPR, verify the implementation of consent management, data subject access requests, data portability, and the right to erasure across all microservices that store personal data. For CCPA, test opt-out mechanisms and data sale disclosures. Verify that the headless architecture properly propagates consent decisions across all integrated systems. Assess data minimization practices—headless systems should collect only essential customer data necessary for operations, anonymize data where personal information is not needed, and enforce data retention policies with automated deletion.

---

## 11. Recommended Tooling

| Category | Primary Tools | Purpose |
|---|---|---|
| **API Proxy and Interception** | Burp Suite Professional, OWASP ZAP, mitmproxy | Request interception, manipulation, and replay for all API testing |
| **API Discovery and Fuzzing** | Kiterunner, ffuf, Arjun, Postman, Insomnia | Endpoint discovery, parameter fuzzing, hidden API path enumeration |
| **GraphQL Testing** | GraphQL Cop, Clairvoyance, InQL (Burp), Altair | Schema extraction, query complexity testing, mutation authorization testing |
| **Authentication Testing** | jwt_tool, Autorize (Burp), OAuth Tester, Hydra | Token manipulation, authorization bypass, credential testing |
| **Vulnerability Scanning** | Nuclei, Nikto, OWASP ASTF, Semgrep | Automated vulnerability detection, misconfiguration scanning, code analysis |
| **Infrastructure and Cloud** | Nmap, Amass, Subfinder, ScoutSuite, Prowler | Network scanning, subdomain enumeration, cloud configuration audit |
| **Automation and Scripting** | Python (requests, aiohttp), Playwright, Selenium, Turbo Intruder | Custom exploit development, race condition testing, business logic automation |
| **SCA and Dependency** | Snyk, npm audit, OWASP Dependency-Check, Trivy | Frontend dependency scanning, container image scanning, license audit |

---

## 12. Severity Classification Framework

All findings must be classified using the following headless-commerce-adapted severity framework:

| Severity | Criteria | Examples |
|---|---|---|
| 🔴 **CRITICAL** | Remote code execution, mass customer data exfiltration, payment system compromise, full admin takeover | SSR code injection, payment webhook forgery leading to free orders, SQL injection in order API, unauth admin API access |
| 🟠 **HIGH** | Individual account takeover, significant financial loss, PII exposure of multiple customers, privilege escalation | BOLA accessing other users' orders/addresses, JWT manipulation for role escalation, stored XSS in product reviews, mass assignment on checkout |
| 🟡 **MEDIUM** | Limited data exposure, business logic abuse with moderate financial impact, information disclosure aiding further attacks | Coupon brute-forcing, cart race conditions, GraphQL introspection enabled, API version disclosure, user enumeration |
| 🟢 **LOW** | Minor information disclosure, theoretical vulnerabilities requiring unlikely conditions, best-practice deviations | Verbose error messages, missing security headers, outdated but unexploitable library versions, overly permissive CORS for non-sensitive endpoints |

---

## 13. Reporting and Deliverables

### 13.1 Report Structure

The final red team report must include the following sections:

- **Executive Summary** — Written for non-technical stakeholders that quantifies risk in business terms
- **Scope and Methodology** — Documenting what was tested and how
- **Findings** — Organized by severity with full reproduction steps, evidence screenshots, affected endpoints, and CVSS scores
- **Risk Analysis** — Mapping findings to business impact (revenue loss, regulatory exposure, reputational damage)
- **Remediation Roadmap** — Prioritized, actionable recommendations including quick wins, short-term fixes, and strategic improvements

### 13.2 Finding Template

Each finding must include:

- **Title:** Clear, descriptive vulnerability name
- **Severity:** Using the classification framework above
- **Affected Component:** Specific API endpoint, microservice, or frontend component
- **OWASP Mapping:** Applicable OWASP API Top 10 or Web Top 10 category
- **Description:** Technical explanation of the vulnerability
- **Reproduction Steps:** Numbered steps with exact API requests, headers, and payloads
- **Evidence:** Screenshots, HTTP request/response pairs, and tool output
- **Business Impact:** Explanation in terms of financial, data, or operational risk
- **Remediation:** Specific, actionable fix with code examples where applicable
- **References:** CVE numbers, OWASP references, and vendor documentation links

### 13.3 Deliverable Timeline

| Deliverable | Timeline | Audience |
|---|---|---|
| **Critical Finding Alerts** | Within 4 hours of discovery | Security Lead, CTO, Incident Response |
| **Daily Status Updates** | End of each testing day | Security Lead, Project Manager |
| **Draft Technical Report** | 5 business days post-testing | Security Team, Development Leads |
| **Executive Summary** | 7 business days post-testing | C-Suite, Board, Compliance |
| **Final Report** | 10 business days post-testing | All stakeholders |
| **Remediation Verification** | 30 days after remediation | Security Team, Development |

---

## 14. Post-Engagement Procedures

### 14.1 Data Handling and Destruction

Upon engagement completion, all testing artifacts containing sensitive data (captured tokens, credentials, PII, API keys, and payment data) must be securely destroyed within 30 days. Provide the client with a signed data destruction certificate. Retain only anonymized findings and the final report per the contractual retention period.

### 14.2 Knowledge Transfer

Conduct a findings walkthrough session with the client's security and development teams. Provide remediation guidance workshops covering the most critical findings. Offer architecture review recommendations for improving the security posture of the headless commerce deployment.

### 14.3 Continuous Improvement

Update this SOP based on lessons learned from each engagement. Track new vulnerability classes specific to headless commerce (e.g., emerging GraphQL attacks, new SSR framework vulnerabilities, novel payment flow exploits). Maintain a headless commerce threat intelligence feed to inform future engagements. Review and update the SOP quarterly to reflect evolving platforms, tools, and threat landscapes.

---

## Appendix A: Engagement Checklist

| Phase | Checklist Item | Status |
|---|---|---|
| **Pre-Eng.** | Signed authorization and scope document obtained | ☐ Not Started |
| **Pre-Eng.** | Rules of engagement agreed and documented | ☐ Not Started |
| **Pre-Eng.** | Communication channels and emergency stop confirmed | ☐ Not Started |
| **Pre-Eng.** | Testing environment and API versions confirmed | ☐ Not Started |
| **Phase 1** | Passive recon: technology stack fingerprinted | ☐ Not Started |
| **Phase 1** | API surface enumerated (REST, GraphQL, gRPC) | ☐ Not Started |
| **Phase 1** | Subdomain and cloud asset discovery completed | ☐ Not Started |
| **Phase 2** | OWASP API Top 10 systematic testing completed | ☐ Not Started |
| **Phase 2** | Authentication and session management tested | ☐ Not Started |
| **Phase 2** | GraphQL-specific attack vectors tested | ☐ Not Started |
| **Phase 3** | SPA bundle analysis and client-side testing completed | ☐ Not Started |
| **Phase 3** | SSR injection and environment variable exposure tested | ☐ Not Started |
| **Phase 4** | Checkout and payment flow manipulation tested | ☐ Not Started |
| **Phase 4** | Cart race conditions and inventory manipulation tested | ☐ Not Started |
| **Phase 4** | Coupon, loyalty, and BNPL abuse scenarios tested | ☐ Not Started |
| **Phase 5** | API gateway and WAF bypass attempted | ☐ Not Started |
| **Phase 5** | Microservice isolation and inter-service auth tested | ☐ Not Started |
| **Phase 5** | Cloud configuration and CDN security assessed | ☐ Not Started |
| **Phase 6** | Webhook security and CMS integration tested | ☐ Not Started |
| **Phase 6** | Dependency audit and SRI verification completed | ☐ Not Started |
| **Phase 7** | PCI DSS alignment validated | ☐ Not Started |
| **Phase 7** | Privacy regulation compliance tested | ☐ Not Started |
| **Post-Eng.** | All critical findings reported within SLA | ☐ Not Started |
| **Post-Eng.** | Final report delivered | ☐ Not Started |
| **Post-Eng.** | Sensitive data securely destroyed | ☐ Not Started |

---

## Appendix B: Document Control

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | January 2025 | Security Team | Initial release |
| 2.0 | September 2025 | Security Team | Added GraphQL testing, MACH architecture coverage, and updated OWASP API Top 10 2023 mapping |
| 3.0 | March 2026 | Security Team | Added SSR vulnerability coverage (CVE-2025-55182), BNPL fraud vectors, supply chain assessment phase, and updated tooling recommendations |

---

*END OF DOCUMENT*
