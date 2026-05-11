# RFC-052: AI-Native Commerce Control Plane Hardening and Productization

- Status: Proposed
- Author: Engineering
- Date: 2026-04-01
- Scope:
  - `packages/core/src/interfaces/mcp/*`
  - `packages/core/src/runtime/*`
  - `packages/core/src/interfaces/rest/router.ts`
  - `packages/core/src/config/*`
  - `packages/core/src/kernel/plugin/*`
  - `packages/cli/*`
  - `packages/skills/*`
  - `packages/cli/templates/*`
- Related:
  - [`RFC-040-AGENTIC-COMMERCE-INFRASTRUCTURE.md`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/RFC-040-AGENTIC-COMMERCE-INFRASTRUCTURE.md)
  - [`RFC-041-CORE-ROUTE-MCP-UNIFICATION.md`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/RFC-041-CORE-ROUTE-MCP-UNIFICATION.md)
  - [`RFC-050-AUTH-KEY-SCOPING.md`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/RFC-050-AUTH-KEY-SCOPING.md)

## 1. Problem Statement

UnifiedCommerce has the correct foundational direction (MCP interface, type-safe route builder, plugin architecture, hardened HTTP middleware), but currently exposes a set of structural weaknesses that block a production-grade AI-native operating model:

1. MCP execution identity is static (`mcp-agent`) rather than request-scoped, resulting in coarse trust and weak attribution.
2. MCP connector bootstrap is incomplete: no OAuth discovery metadata and no standards-compliant challenge surface for auto-configuring MCP clients.
3. `mcp.capabilities` is configuration metadata without runtime enforcement in tool dispatch.
4. Plugin trust model is single-tier, in-process, and privilege-rich. Third-party extension execution has no isolation boundary.
5. Plugin route authorization defaults are permissive (`.auth()` and `.permission()` opt-in), allowing accidental unauthenticated exposure.
6. CLI surface is not yet an AI/operator-grade remote control plane with robust auth, token lifecycle, and script-oriented output contracts.
7. Skills exist, but distribution into starters is not standardized as a first-class product behavior.

This RFC proposes a coherent architecture to close these gaps while preserving UnifiedCommerce’s existing strengths: global middleware hardening, org-scoped DB behavior, and modular domain services.

## 2. Research-Derived Direction (External Pattern Inputs)

This proposal is materially informed by the EmDash architecture from Cloudflare’s April 1, 2026 publication and its reference implementation:

- Blog announcement (AI-native CMS positioning): [Cloudflare EmDash announcement](https://blog.cloudflare.com/emdash-wordpress/)
- Reference implementation: [emdash-cms/emdash](https://github.com/emdash-cms/emdash)

Concrete patterns adapted in this RFC:

1. Request-scoped MCP auth context passed through transport into tool handlers.
2. OAuth protected-resource and authorization-server metadata endpoints.
3. Layered authorization in tool handlers (scope + role + ownership semantics).
4. Plugin marketplace install/update hardening (manifest validation, capability escalation consent, checksum validation, local artifact copy).
5. Trust-tiered plugin runtime with isolated execution for untrusted code.
6. Skills synchronized into starter templates with deterministic repo automation.

## 3. Pseudocode (Normative)

The pseudocode in this section is normative for control-flow semantics. The blueprint in Section 4 is normative for file-level implementation.

### 3.1 MCP Request Identity and Authorization Context

```pseudo
function handleMcpPost(request):
  actor = authenticateRequest(request)
  if actor == null:
    return 401 with WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"

  tokenContext = extractTokenContext(request)  // scopes, client_id, token_id
  mcpContext = {
    actor: actor,
    auth: tokenContext,
    kernel: kernel,
    requestId: request.requestId
  }

  server = buildMcpServer(kernel, mcpContext)
  return streamableHttpTransport.handle(request, { extra: mcpContext })
```

### 3.2 Tool-Level Capability and Scope Enforcement

```pseudo
function executeTool(toolName, args, ctx):
  requiredMcpCapability = toolRegistry.getCapability(toolName)
  requiredScopes = toolRegistry.getScopes(toolName)

  if requiredMcpCapability not in config.mcp.capabilities:
    return error(MCP_CAPABILITY_DISABLED)

  if ctx.auth.tokenScopes is defined:
    for each scope in requiredScopes:
      if scope not in ctx.auth.tokenScopes and "admin" not in ctx.auth.tokenScopes:
        return error(INSUFFICIENT_SCOPE)

  // route or service-level authorization still applies
  return toolRegistry.dispatch(toolName, args, ctx)
```

### 3.3 OAuth Discovery Endpoints for MCP Clients

```pseudo
function getProtectedResourceMetadata(origin):
  return {
    resource: origin + "/mcp",
    authorization_servers: [origin + "/_uc"],
    scopes_supported: VALID_SCOPES,
    bearer_methods_supported: ["header"]
  }

function getAuthorizationServerMetadata(origin):
  return {
    issuer: origin + "/_uc",
    authorization_endpoint: origin + "/_uc/oauth/authorize",
    token_endpoint: origin + "/_uc/api/oauth/token",
    device_authorization_endpoint: origin + "/_uc/api/oauth/device/code",
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    code_challenge_methods_supported: ["S256"]
  }
```

### 3.4 Plugin Trust Tiering and Bundle Verification

```pseudo
enum PluginTrustTier = { TRUSTED, SANDBOXED }

function installPlugin(bundle):
  manifest = parseAndValidateManifest(bundle.manifest)
  verifyChecksum(bundle, marketplaceRecord.checksum)
  verifySignature(bundle, marketplaceRecord.signature)
  enforceCapabilityPolicy(manifest.capabilities)

  if manifest.trustTier == SANDBOXED:
    require(sandboxRunner.isAvailable)
    copyBundleToLocalArtifactStore(bundle)
    registerPluginState(pluginId, source=marketplace, trustTier=SANDBOXED)
  else:
    registerPluginState(pluginId, source=config, trustTier=TRUSTED)
```

### 3.5 Plugin Route Default Auth Semantics

```pseudo
function compilePluginRoute(routeDef):
  if routeDef.public == true:
    routePolicy = PUBLIC
  else:
    routePolicy = AUTH_REQUIRED  // default

  if routeDef.permission is present:
    routePolicy = AUTH_AND_PERMISSION(routeDef.permission)

  return routePolicy
```

### 3.6 CLI Auth Resolution and Remote Control Plane

```pseudo
function resolveCliAuth(args, env, credentialStore):
  if args.token present: return token(args.token)
  if env.UC_TOKEN present: return token(env.UC_TOKEN)
  if credentialStore.has(args.url):
    creds = credentialStore.get(args.url)
    if creds.expired and creds.refreshToken present:
      creds = refresh(creds)
      credentialStore.save(args.url, creds)
    return token(creds.accessToken)
  if isLocalhost(args.url):
    return devBypass()
  return unauthenticated()
```

### 3.7 Skill Distribution Pipeline for Starters

```pseudo
function syncStarterSkills():
  for each template in templates:
    copy skills/{unified-commerce, mcp-ops, plugin-security} -> template/.agents/skills/
    symlink template/.claude/skills -> ../.agents/skills
    copy canonical AGENTS.md -> template/AGENTS.md
    symlink template/CLAUDE.md -> AGENTS.md
```

## 4. Code Blueprint (File-Level Implementation)

This section is intentionally explicit to minimize implementation drift and eliminate interpretive ambiguity.

### 4.1 MCP Identity and Auth Context Refactor

#### 4.1.1 New Types

Add a strongly typed MCP auth context in `packages/core/src/interfaces/mcp/types.ts`:

- `McpAuthContext`
  - `actor: Actor`
  - `tokenScopes?: string[]`
  - `clientId?: string`
  - `tokenId?: string`
  - `requestId: string`

#### 4.1.2 Transport Wiring

Modify [`packages/core/src/interfaces/mcp/transport.ts`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/packages/core/src/interfaces/mcp/transport.ts):

1. Remove implicit dependency on static kernel actor semantics.
2. Inject request actor and token metadata from Hono context into transport `extra`.
3. Emit MCP-protocol-compliant 401 on unauthenticated requests with `WWW-Authenticate` challenge.
4. Preserve stateless streamable HTTP model.

#### 4.1.3 Kernel Contract Update

Deprecate and remove static MCP actor fallback in [`packages/core/src/runtime/kernel.ts`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/packages/core/src/runtime/kernel.ts):

- Remove `getMCPActor()` as authoritative identity source.
- If retained temporarily for migration, gate behind internal fallback flag and log warning on every invocation.

### 4.2 OAuth Discovery and Challenge Surface

Add routes in `packages/core/src/runtime/server.ts` or a dedicated auth route module:

1. `GET /.well-known/oauth-protected-resource`
2. `GET /_uc/.well-known/oauth-authorization-server`

Requirements:

- Dynamic origin derivation from request.
- Declarative `scopes_supported` sourced from central scope registry.
- `Cache-Control: public, max-age=3600`.
- CORS allowlist for metadata endpoints only.

Challenge behavior:

- For `/mcp` unauthenticated or invalid token path, return:
  - status: `401`
  - header: `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`

### 4.3 Runtime Enforcement of MCP Capabilities

Modify:

- [`packages/core/src/config/types.ts`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/packages/core/src/config/types.ts)
- [`packages/core/src/config/defaults.ts`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/packages/core/src/config/defaults.ts)
- [`packages/core/src/interfaces/mcp/tools/registry.ts`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/packages/core/src/interfaces/mcp/tools/registry.ts)

Implementation:

1. Introduce explicit `McpCapability` enum or string-literal union.
2. Attach required capability metadata to each tool registration.
3. Add pre-dispatch capability guard in tool registry.
4. Return deterministic error envelopes:
   - `MCP_CAPABILITY_DISABLED`
   - `INSUFFICIENT_SCOPE`
   - `INSUFFICIENT_PERMISSION`

### 4.4 Tool-Level Defense-in-Depth Authorization

Extend MCP tool metadata model to include:

- `requiredScopes: string[]`
- `minimumRole?: Role`
- `ownershipConstraint?: OwnershipPolicy`

At dispatch:

1. Scope check.
2. Role floor check.
3. Ownership predicate for write-paths with resource identifiers.

Rationale:

- Prevents accidental broad authorization if any single layer regresses.
- Aligns with production pattern observed in EmDash MCP server (`requireScope`, `requireRole`, `requireOwnership` composition).

### 4.5 Plugin Trust Tier Architecture

#### 4.5.1 Manifest Model Extension

Update [`packages/core/src/kernel/plugin/manifest.ts`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/packages/core/src/kernel/plugin/manifest.ts):

- Add `trustTier: "trusted" | "sandboxed"` (default `"trusted"` for backward compatibility in current ecosystem).
- Add `allowedHosts` for network egress policy.
- Add signed bundle metadata hooks:
  - `bundleChecksum`
  - `bundleSignature`
  - `signatureKeyId`

#### 4.5.2 Loader Strategy

Create `packages/core/src/kernel/plugin/runtime/`:

- `trusted-loader.ts` (existing behavior)
- `sandboxed-loader.ts` (new bridge-based behavior)
- `policy.ts` (trust-tier admission logic)

The sandboxed loader MUST:

1. Execute plugin code out-of-process or isolate-boundary (implementation may vary by runtime target).
2. Expose only capability-gated RPC surface (no raw service container, no raw DB handle).
3. Apply egress control via allowlist, including redirect re-validation.
4. Enforce execution budget (cpu/wall-time/subrequest semantics, depending on runtime support).

#### 4.5.3 Marketplace Install and Update Controls

When plugin marketplace pipeline is introduced/expanded:

1. Validate manifest against strict schema.
2. Verify checksum and signature prior to activation.
3. Block install on capability policy violations.
4. Require explicit user confirmation for:
   - capability additions
   - newly public routes
5. Copy artifacts to local store before activation to avoid remote registry dependency at runtime.

### 4.6 Plugin Route Security Defaults

Modify [`packages/core/src/interfaces/rest/router.ts`](/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine/packages/core/src/interfaces/rest/router.ts):

Current behavior:

- auth and permission are opt-in.

Target behavior:

1. Route default policy for plugin routes: authenticated.
2. Public exposure requires explicit `.public()` or equivalent manifest declaration.
3. Build-time plugin validation:
   - fail if `.permission("x:y")` is used without declaring `x:y` in plugin manifest permissions.
4. Ensure OpenAPI generation reflects actual route security policy.

### 4.7 CLI Remote Control Plane Expansion

Extend `packages/cli` with a remote operator surface:

- Auth:
  - `uc login`
  - `uc logout`
  - `uc whoami`
- Domain command groups:
  - `uc catalog *`
  - `uc inventory *`
  - `uc orders *`
  - `uc pricing *`
  - `uc promotions *`

Cross-cutting requirements:

1. Shared connection args (`--url`, `--token`, `--header`, `--json`).
2. Auth resolution precedence chain identical to pseudocode.
3. Token refresh interceptor path.
4. TTY-aware pretty output and strict JSON mode for automation pipelines.
5. Read-before-write optimistic concurrency support where mutation safety is required.

### 4.8 Skills as Shippable Runtime Adjacent Artifacts

Create deterministic skill sync automation analogous to template scaffolding:

1. Canonical `AGENTS.md` in starter root.
2. `.agents/skills` populated from curated `packages/skills`.
3. `.claude/skills` symlink to `.agents/skills`.
4. Sync script integrated into template generation workflow.

## 5. Security Model and Threat Analysis

### 5.1 Threat Categories

1. Tool invocation with forged or over-scoped identity.
2. Privilege escalation via MCP tool dispatch bypass.
3. Plugin remote-code execution with unrestricted host access.
4. Accidental anonymous route exposure from plugin authorship errors.
5. Artifact substitution attack in plugin distribution.
6. Runtime breakage from marketplace/registry outage.

### 5.2 Required Mitigations

1. Request-scoped actor context and explicit scope checks.
2. Deterministic capability gating before tool execution.
3. Signature and checksum verification before plugin activation.
4. Default-authenticated route posture.
5. Egress policy with redirect chain validation.
6. Local artifact store for runtime resiliency.

## 6. Rollout Plan

### Phase 1: MCP Identity and Capability Enforcement

- Deliverables:
  - request-scoped MCP auth context
  - OAuth metadata endpoints
  - `WWW-Authenticate` challenge support
  - `mcp.capabilities` enforcement

### Phase 2: Plugin Route Default-Secure Posture

- Deliverables:
  - plugin route default auth
  - explicit public route declaration path
  - manifest-permission to route-permission validation

### Phase 3: CLI Operator Surface

- Deliverables:
  - login/logout/whoami
  - domain remote commands
  - token refresh and credential persistence

### Phase 4: Trust-Tier Plugin Runtime

- Deliverables:
  - trust-tier manifest
  - sandboxed execution adapter
  - capability-gated plugin RPC context
  - artifact verification and local caching

### Phase 5: Skills Productization

- Deliverables:
  - skill sync script
  - starter template integration
  - canonical AGENTS guidance across generated projects

## 7. Compatibility and Migration Notes

1. MCP clients currently assuming unauthenticated localhost access will require token or dev bypass configuration.
2. Plugin routes relying on implicit public exposure must explicitly annotate public semantics.
3. Plugin authors will need manifest permission declarations aligned with route-level permission usage.
4. CLI users gain new commands; existing scaffolding commands remain unaffected.

## 8. Testing Strategy

### 8.1 Unit

1. MCP capability guard matrix.
2. Scope/role/ownership policy evaluator.
3. OAuth metadata payload generation.
4. Plugin route policy compiler (default auth, explicit public).

### 8.2 Integration

1. MCP 401 challenge behavior and discovery flow.
2. Authenticated tool invocation with scoped tokens.
3. Plugin route access matrix across anonymous/authenticated/authorized actors.
4. CLI login and token refresh lifecycle.

### 8.3 Security Regression

1. Forced tool call against disabled capability.
2. Token with insufficient scope against write tool.
3. Plugin route permission mismatch during boot.
4. Sandboxed plugin network call to disallowed host.
5. Redirect chain egress bypass attempt.
6. Tampered plugin bundle checksum/signature validation failure.

## 9. Definition of Done

1. No MCP path depends on static actor identity.
2. MCP unauthenticated responses advertise protected-resource metadata via standard challenge header.
3. Every tool has explicit capability and scope metadata enforced at runtime.
4. Plugin routes are authenticated by default.
5. Plugin permission declarations are validated against route requirements at startup/build time.
6. CLI includes authenticated remote control plane with stable JSON output contracts.
7. Starter templates include synchronized skills and AGENTS guidance.
8. End-to-end test suite covers all new security-critical paths.

## 10. Implementation Risks and Countermeasures

1. Risk: Over-constraining MCP could break existing automation.
   - Countermeasure: phased rollout with feature flags and compatibility telemetry.
2. Risk: Plugin ecosystem friction from new manifest requirements.
   - Countermeasure: strict validation errors with actionable diagnostics and migration docs.
3. Risk: Sandbox adapter complexity across runtimes.
   - Countermeasure: interface-first design with trusted fallback and runtime capability probing.
4. Risk: CLI scope creep.
   - Countermeasure: domain-prioritized command rollout with explicit SLAs on output schemas.

## 11. Final Position

UnifiedCommerce should treat AI-native operation as a security and control-plane architecture problem, not a tooling veneer. The minimum viable posture is request-scoped MCP identity, standards-compliant connector auth discovery, runtime capability enforcement, default-secure plugin routing, and deterministic operational interfaces (CLI plus skills). The proposed architecture intentionally front-loads hardening in identity, authorization, and extension isolation, because these are the highest-impact failure domains once agents become first-class actors in the commerce runtime.

