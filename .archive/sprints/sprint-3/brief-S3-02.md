# Story Brief — `S3-02` Implement `GET /api/admin/permissions`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-02] GET /api/admin/permissions`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-02-admin-permissions.done`.

---

## 1. Goal

The plugin manifest collects `permissions: PluginPermission[]` and the JSDoc claims they're "available via GET /api/admin/permissions". The route doesn't exist. Either implement it or delete the JSDoc claim. **Implement it** — admins benefit from introspection.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §4.
2. `packages/core/src/kernel/plugin/manifest.ts` — find where `permissions` is collected during `defineCommercePlugin` config transform. Trace where it lands in the resolved config.
3. `packages/core/src/runtime/kernel.ts` — see if collected permissions are exposed on the kernel. If not, expose them (as `kernel.pluginPermissions: PluginPermission[]`).
4. The admin route module from S0-05: `packages/core/src/interfaces/rest/routes/admin/compensation-failures.ts` — model pattern.
5. `packages/core/src/auth/permissions.ts` — `assertPermission`.

---

## 3. Approach

1. Verify `config.permissions` (or wherever they accumulate) is populated in the resolved config.
2. Expose them on the kernel: `kernel.pluginPermissions: PluginPermission[]` (typed in `Kernel` interface).
3. New route at `packages/core/src/interfaces/rest/routes/admin/permissions.ts` — `GET /api/admin/permissions` returns:
   ```json
   {
     "core": ["catalog:read", "catalog:create", ...],   // from config.auth.roles flattened
     "plugin": [
       { "scope": "gift-cards:admin", "description": "...", "plugin": "gift-cards" },
       ...
     ]
   }
   ```
4. Permission gate: `assertPermission(actor, "admin")` (or whatever the admin scope is).

---

## 4. Files to modify

**Modify:**
- `packages/core/src/kernel/plugin/manifest.ts` — ensure permissions collected to `config.pluginPermissions` (or similar). Add `pluginId` field to each so the route can group.
- `packages/core/src/runtime/kernel.ts` — expose `pluginPermissions` on `Kernel`.
- `packages/core/src/interfaces/rest/index.ts` — register the new admin route.

**Create:**
- `packages/core/src/interfaces/rest/routes/admin/permissions.ts` — Hono OpenAPI route.
- `packages/core/test/admin-permissions-route.test.ts` — register a test plugin with permissions; hit the endpoint as admin; assert response shape.

---

## 5. Acceptance criteria

1. Plugin permissions collected from manifests during config resolution.
2. `GET /api/admin/permissions` returns `{ core, plugin }` shape, admin-gated.
3. Test plugin with permissions appears in response.
4. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-02] GET /api/admin/permissions`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT validate permissions against actual route `.permission()` calls in this story (backlog B-07).
- Do NOT make this endpoint public — admin only.
- Do NOT modify the `PluginPermission` type beyond optionally adding `pluginId`.
