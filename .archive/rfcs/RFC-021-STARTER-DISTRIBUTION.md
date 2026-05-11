# RFC-021: Starter Distribution Pipeline

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-18
- **Scope:** `packages/core`, `packages/sdk`, `packages/adapters/*`, `packages/plugins/*`, `packages/cli`, `apps/fashion-starter`, `.changeset/`, `.github/workflows/`
- **Motivation:** Every `@unifiedcommerce/*` package is `"private": true` with exports pointing to raw `.ts` source files. The fashion starter cannot be extracted from the monorepo because its dependencies do not exist on any public registry. This RFC defines the complete pipeline: compiled package builds, semver-managed publishing via Changesets, a `create-uc-app` CLI that scaffolds starters from GitHub tar archives with published dependency versions, and a Docker Compose target for zero-setup evaluation.
- **Prior art:** `create-next-app` (GitHub codeload tar extraction), `create-t3-app` (compositional bundled templates), `create-medusa-app` (git clone from starter repo), Shopify Hydrogen CLI (programmatic file generation), SvelteKit `sv create` (dedicated create package)
- **Estimated effort:** 8-10 engineering-days

---

## 1. Problem

### 1.1 Packages Are Not Publishable

Every `@unifiedcommerce/*` package has `"private": true`. The `exports` field in each `package.json` points to raw TypeScript source:

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  }
}
```

This works inside the Bun workspace because Bun resolves `.ts` imports natively. External consumers -- anyone outside this monorepo -- cannot install or import these packages. The packages are not on npm. They have no compiled output referenced in `exports`. There is no `publishConfig`, no `.npmignore`, no build-then-publish pipeline.

### 1.2 The Fashion Starter Is Monorepo-Locked

`apps/fashion-starter/package.json` declares workspace dependencies:

```json
{
  "@unifiedcommerce/core": "*",
  "@unifiedcommerce/sdk": "*",
  "@unifiedcommerce/adapter-postgres": "*",
  "@unifiedcommerce/adapter-local-storage": "*",
  "@unifiedcommerce/adapter-stripe": "*",
  "@unifiedcommerce/adapter-resend": "*",
  "@unifiedcommerce/plugin-gift-cards": "*"
}
```

The bare `"*"` version specifier resolves via Bun workspace linking. Outside the monorepo, `"*"` would match any version on npm -- but none exist. The starter also hardcodes monorepo-relative paths in `drizzle.config.ts`:

```typescript
schema: [
  "../../packages/core/src/kernel/database/schema.ts",
  "../../packages/plugins/*/src/schema.ts",
]
```

These paths do not exist in a standalone project.

### 1.3 The CLI Template Is Stale

`packages/cli/templates/starter/package.json` references `@unifiedcommerce/*: "latest"`. Since no packages are published, `bun install` would fail for any user running `unifiedcommerce init my-store`.

### 1.4 No Versioning or Release Automation

There is no `.changeset/` directory, no GitHub Actions workflow for publishing, no version coordination across the 22 `@unifiedcommerce/*` packages. Version fields are all `0.0.1` with no changelog tracking.

---

## 2. Design

The distribution pipeline has four layers, each independently shippable:

```
Layer 1: Package Build Pipeline (tsup + dual ESM/CJS output)
    |
Layer 2: Version Management (Changesets + linked versioning)
    |
Layer 3: Registry Publishing (npm publish via CI)
    |
Layer 4: Starter Scaffolding (create-uc-app + GitHub tar extraction)
    +-- Docker Compose (optional zero-setup evaluation)
```

### 2.1 Layer 1: Package Build Pipeline

#### 2.1.1 Problem with Current Build

Current packages use `tsc -p tsconfig.build.json` which emits declaration files and JavaScript to `dist/`, but the `exports` field in `package.json` ignores `dist/` entirely. This means the build output exists but is never consumed.

#### 2.1.2 Solution: tsup for All Library Packages

Replace `tsc` builds with `tsup` for all publishable `@unifiedcommerce/*` packages. tsup produces:
- ESM output (`.js` with `"type": "module"`)
- Declaration files (`.d.ts` via `--dts`)
- Source maps
- Tree-shakeable output (no barrel re-export overhead)

**tsup configuration (shared pattern for all packages):**

```typescript
// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    // Peer dependencies -- never bundled
    "drizzle-orm",
    "drizzle-orm/pg-core",
    "hono",
    "@hono/zod-openapi",
    "better-auth",
    "zod",
    "pino",
  ],
  // Do NOT bundle other @unifiedcommerce/* packages
  // They are declared as dependencies and resolved at install time
  noExternal: [],
});
```

**Package.json exports after build:**

```json
{
  "name": "@unifiedcommerce/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "publishConfig": {
    "access": "public"
  }
}
```

The `"files"` array ensures only `dist/` and `README.md` are included in the npm tarball. Source files, tests, and config files are excluded.

#### 2.1.3 Dual Exports: Source for Monorepo, Compiled for npm

During development inside the monorepo, Bun resolves `.ts` imports directly. Published consumers use the compiled `dist/` output. This is achieved via conditional exports:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "bun": "./src/index.ts",
      "import": "./dist/index.js"
    }
  }
}
```

The `"bun"` condition is resolved first by Bun, falling back to `"import"` for Node.js and other runtimes. This eliminates the need to rebuild during development while ensuring published packages work outside the monorepo.

#### 2.1.4 Packages to Publish

The following 16 packages transition from `"private": true` to publishable:

| Package | npm Name | Rationale |
|---------|----------|-----------|
| `packages/core` | `@unifiedcommerce/core` | Engine kernel, services, hooks, schema |
| `packages/sdk` | `@unifiedcommerce/sdk` | Typed HTTP client + React hooks |
| `packages/cli` | `@unifiedcommerce/cli` | Scaffolding + dev/migrate/deploy commands |
| `packages/adapters/adapter-postgres` | `@unifiedcommerce/adapter-postgres` | PostgreSQL database adapter |
| `packages/adapters/adapter-local-storage` | `@unifiedcommerce/adapter-local-storage` | Local file storage adapter |
| `packages/adapters/adapter-s3` | `@unifiedcommerce/adapter-s3` | AWS S3 storage adapter |
| `packages/adapters/adapter-r2` | `@unifiedcommerce/adapter-r2` | Cloudflare R2 storage adapter |
| `packages/adapters/adapter-stripe` | `@unifiedcommerce/adapter-stripe` | Stripe payment adapter |
| `packages/adapters/adapter-resend` | `@unifiedcommerce/adapter-resend` | Resend email adapter |
| `packages/adapters/adapter-ses` | `@unifiedcommerce/adapter-ses` | AWS SES email adapter |
| `packages/adapters/adapter-meilisearch` | `@unifiedcommerce/adapter-meilisearch` | Meilisearch search adapter |
| `packages/adapters/adapter-pg-search` | `@unifiedcommerce/adapter-pg-search` | PostgreSQL full-text search adapter |
| `packages/adapters/adapter-tax-manual` | `@unifiedcommerce/adapter-tax-manual` | Manual tax calculation adapter |
| `packages/plugins/plugin-gift-cards` | `@unifiedcommerce/plugin-gift-cards` | Gift card plugin |
| `packages/plugins/plugin-marketplace` | `@unifiedcommerce/plugin-marketplace` | Multi-vendor marketplace plugin |
| `packages/plugins/plugin-appointments` | `@unifiedcommerce/plugin-appointments` | Appointment scheduling plugin |

Packages NOT published (internal tooling):
- `@porulle/ui`, `@porulle/eslint-config`, `@porulle/typescript-config` -- monorepo-internal dev tooling
- `@unifiedcommerce/plugin-cubejs`, `@unifiedcommerce/plugin-pos` -- not yet production-ready
- `@unifiedcommerce/import-*` -- import utilities, bundled into the CLI

### 2.2 Layer 2: Version Management (Changesets)

#### 2.2.1 Changeset Configuration

```json
// .changeset/config.json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [
    ["@unifiedcommerce/core", "@unifiedcommerce/sdk"]
  ],
  "linked": [
    ["@unifiedcommerce/adapter-*"],
    ["@unifiedcommerce/plugin-*"]
  ],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": [
    "@porulle/ui",
    "@porulle/eslint-config",
    "@porulle/typescript-config",
    "@unifiedcommerce/fashion-starter",
    "docs",
    "web",
    "store-example",
    "runvae"
  ]
}
```

**Versioning strategy:**

- **Fixed:** `core` and `sdk` are always released together at the same version. A change to core automatically bumps sdk and vice versa. These are the two packages every consumer depends on; version alignment prevents "which sdk version works with which core?" confusion.
- **Linked:** All adapters share a version range. All plugins share a version range. A major bump to any adapter bumps all adapters. This simplifies the compatibility matrix. Within a linked group, only packages with actual changesets are published, but they all receive the same version bump.
- **Ignored:** Apps, internal tooling, and starters are never published to npm.

#### 2.2.2 Developer Workflow

```
1. Developer makes a change to @unifiedcommerce/core
2. Developer runs: npx changeset
   -> Selects: @unifiedcommerce/core
   -> Selects bump type: minor
   -> Writes summary: "Add includeOptionTypes to catalog getById"
   -> Creates: .changeset/happy-dogs-dance.md
3. Developer commits the changeset file with the code change
4. PR is merged to main
5. CI creates a "Version Packages" PR (via @changesets/action)
   -> Bumps core 0.1.0 -> 0.2.0
   -> Bumps sdk 0.1.0 -> 0.2.0 (fixed group)
   -> Updates CHANGELOG.md in each package
6. Team merges the "Version Packages" PR
7. CI publishes all bumped packages to npm
```

### 2.3 Layer 3: Registry Publishing (CI)

#### 2.3.1 GitHub Actions Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches: [main]

concurrency: ${{ github.workflow }}-${{ github.ref }}

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      - name: Build all publishable packages
        run: bun run build --filter='@unifiedcommerce/*'

      - name: Run tests
        run: bun run test

      - name: Type check
        run: bun run check-types

      - name: Create Release Pull Request or Publish
        id: changesets
        uses: changesets/action@v1
        with:
          version: npx changeset version
          publish: npx changeset publish
          commit: "chore: version packages"
          title: "chore: version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Tag release
        if: steps.changesets.outputs.published == 'true'
        run: |
          VERSION=$(node -p "require('./packages/core/package.json').version")
          git tag "v${VERSION}"
          git push origin "v${VERSION}"
```

#### 2.3.2 npm Organization

Publish under the `@unifiedcommerce` npm scope. Requires:
1. Create the `unifiedcommerce` npm organization at npmjs.com
2. Generate an automation token for CI (`NPM_TOKEN`)
3. Add `NPM_TOKEN` to GitHub repository secrets

#### 2.3.3 Provenance

The workflow uses `id-token: write` permission to enable npm provenance attestation. Published packages will show a verified "Published via GitHub Actions" badge on npmjs.com, proving the build came from the source repository.

### 2.4 Layer 4: Starter Scaffolding

#### 2.4.1 Architecture Decision: GitHub Tar Extraction

The `create-next-app` pattern is the best fit for UnifiedCommerce:

1. Starters live in the monorepo under `apps/` (single source of truth)
2. The CLI extracts a specific subdirectory from a GitHub tar archive at a tagged version
3. The extracted `package.json` is rewritten to reference published `@unifiedcommerce/*` versions

**Why not other approaches:**

| Approach | Rejection Reason |
|----------|-----------------|
| Bundled templates in CLI | Templates become stale between CLI releases. Fashion starter is 222 files -- too large to bundle in an npm package. |
| Separate template repos | Two repos to maintain. Drift between starter and core is guaranteed. |
| Git clone | Downloads full git history. `.git` directory confuses users. |
| Programmatic generation | Fashion starter is too complex for compositional generation. It is a complete Next.js application with 50+ components. |

#### 2.4.2 The `create-uc-app` Package

Published as `create-uc-app` on npm. Invoked via:

```bash
npx create-uc-app my-store
npx create-uc-app my-store --starter fashion
npx create-uc-app my-store --starter headless
```

**Implementation pseudocode:**

```
FUNCTION create_uc_app(project_name, options):
    destination = resolve(cwd, project_name)
    IF exists(destination): THROW "Directory already exists"

    starter = options.starter OR "fashion"
    version = options.version OR "latest"

    // 1. Resolve the target version tag
    IF version == "latest":
        tag = fetch_latest_git_tag("octalpixel/unified-commerce")
    ELSE:
        tag = "v" + version

    // 2. Download and extract the starter subdirectory from GitHub
    tar_url = "https://codeload.github.com/octalpixel/unified-commerce/tar.gz/" + tag
    extract_tar_subdirectory(tar_url, "apps/" + starter, destination)

    // 3. Rewrite package.json with published versions
    pkg = read_json(destination + "/package.json")
    pkg.name = project_name
    core_version = resolve_npm_version("@unifiedcommerce/core", tag)
    FOR dep IN pkg.dependencies:
        IF dep.startsWith("@unifiedcommerce/"):
            pkg.dependencies[dep] = "^" + core_version
    // Remove workspace-only dependencies
    DELETE pkg.dependencies["@porulle/eslint-config"]
    DELETE pkg.dependencies["@porulle/typescript-config"]
    write_json(destination + "/package.json", pkg)

    // 4. Rewrite drizzle.config.ts to use node_modules paths
    rewrite_drizzle_config(destination)

    // 5. Generate .env from template
    copy(destination + "/.env.template", destination + "/.env")

    // 6. Install dependencies
    detect_package_manager()
    run(package_manager, "install", { cwd: destination })

    // 7. Print next steps
    PRINT "Project created at " + destination
    PRINT "  cd " + project_name
    PRINT "  cp .env.template .env  # configure DATABASE_URL"
    PRINT "  bun run db:push"
    PRINT "  bun run seed"
    PRINT "  bun run dev"
```

#### 2.4.3 Code Blueprint: `create-uc-app`

```typescript
// packages/create-uc-app/src/index.ts
#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { downloadTemplate } from "giget";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, cp } from "node:fs/promises";
import { execSync } from "node:child_process";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const REPO = "octalpixel/unified-commerce";
const STARTERS: Record<string, string> = {
  fashion: "apps/fashion-starter",
  headless: "apps/store-example",
};

async function resolveLatestTag(): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github.v3+json" } },
  );
  if (!res.ok) return "main";
  const data = (await res.json()) as { tag_name: string };
  return data.tag_name;
}

async function resolvePublishedVersion(tag: string): Promise<string> {
  // Extract version from tag (v0.2.0 -> 0.2.0)
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  // Verify it exists on npm; fallback to tag if not
  try {
    const res = await fetch(
      `https://registry.npmjs.org/@unifiedcommerce/core/${version}`,
    );
    if (res.ok) return version;
  } catch { /* fallback */ }
  return version;
}

function rewriteDrizzleConfig(content: string): string {
  // Replace monorepo-relative schema paths with node_modules paths
  return content
    .replace(
      /["']\.\.\/\.\.\/packages\/core\/src\/kernel\/database\/schema\.ts["']/g,
      '"./node_modules/@unifiedcommerce/core/dist/kernel/database/schema.js"',
    )
    .replace(
      /["']\.\.\/\.\.\/packages\/plugins\/\*\/src\/schema\.ts["']/g,
      '"./node_modules/@unifiedcommerce/plugin-*/dist/schema.js"',
    );
}

const main = defineCommand({
  meta: {
    name: "create-uc-app",
    version: "0.1.0",
    description: "Scaffold a UnifiedCommerce storefront",
  },
  args: {
    projectName: {
      type: "positional",
      description: "Project directory name",
      required: true,
    },
    starter: {
      type: "string",
      default: "fashion",
      description: "Starter template: fashion, headless",
    },
    version: {
      type: "string",
      default: "latest",
      description: "UnifiedCommerce version (tag or 'latest')",
    },
  },
  async run({ args }) {
    const projectName = String(args.projectName);
    const destination = resolve(process.cwd(), projectName);

    if (existsSync(destination)) {
      throw new Error(`Directory "${projectName}" already exists.`);
    }

    const starterKey = String(args.starter);
    const starterPath = STARTERS[starterKey];
    if (!starterPath) {
      throw new Error(
        `Unknown starter "${starterKey}". Available: ${Object.keys(STARTERS).join(", ")}`,
      );
    }

    const requestedVersion = String(args.version);
    const tag =
      requestedVersion === "latest"
        ? await resolveLatestTag()
        : requestedVersion.startsWith("v")
          ? requestedVersion
          : `v${requestedVersion}`;

    console.log(`Downloading ${starterKey} starter from ${REPO}@${tag}...`);

    // giget extracts a subdirectory from a GitHub tarball
    await downloadTemplate(`gh:${REPO}/${starterPath}#${tag}`, {
      dir: destination,
      force: true,
    });

    // Rewrite package.json
    const pkgPath = join(destination, "package.json");
    const pkg: PackageJson = JSON.parse(await readFile(pkgPath, "utf8"));
    pkg.name = projectName;

    const publishedVersion = await resolvePublishedVersion(tag);
    const versionSpec = `^${publishedVersion}`;

    // Replace workspace specifiers with published versions
    for (const depField of ["dependencies", "devDependencies"] as const) {
      const deps = pkg[depField];
      if (!deps) continue;
      for (const [name, ver] of Object.entries(deps)) {
        if (name.startsWith("@unifiedcommerce/") && (ver === "*" || ver === "workspace:*")) {
          deps[name] = versionSpec;
        }
      }
      // Remove monorepo-internal deps
      delete deps["@porulle/eslint-config"];
      delete deps["@porulle/typescript-config"];
      delete deps["@porulle/ui"];
    }

    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    // Rewrite drizzle.config.ts if it exists
    const drizzlePath = join(destination, "drizzle.config.ts");
    if (existsSync(drizzlePath)) {
      const content = await readFile(drizzlePath, "utf8");
      await writeFile(drizzlePath, rewriteDrizzleConfig(content));
    }

    // Generate .env from template if exists
    const envTemplate = join(destination, ".env.template");
    const envFile = join(destination, ".env");
    if (existsSync(envTemplate) && !existsSync(envFile)) {
      await cp(envTemplate, envFile);
    }

    console.log(`\nProject created at ${destination}\n`);
    console.log("Next steps:");
    console.log(`  cd ${projectName}`);
    console.log("  bun install");
    console.log("  # Edit .env with your DATABASE_URL");
    console.log("  bun run db:push");
    console.log("  bun run seed");
    console.log("  bun run dev");
  },
});

await runMain(main);
```

#### 2.4.4 `create-uc-app` Package Configuration

```json
{
  "name": "create-uc-app",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "create-uc-app": "./dist/index.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean"
  },
  "dependencies": {
    "citty": "^0.1.6",
    "giget": "^2.0.0"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Note: `create-uc-app` is published as an **unscoped** package so `npx create-uc-app` works without the `@unifiedcommerce/` prefix. The `npm create` convention resolves `npm create uc-app` to `npx create-uc-app`.

### 2.5 Starter Preparation: Fashion Starter Standalone Readiness

The fashion starter requires the following modifications to function as a standalone project:

#### 2.5.1 drizzle.config.ts

Current (monorepo-relative):
```typescript
schema: [
  "../../packages/core/src/kernel/database/schema.ts",
  "../../packages/plugins/*/src/schema.ts",
]
```

Standalone (node_modules):
```typescript
schema: [
  "./node_modules/@unifiedcommerce/core/dist/kernel/database/schema.js",
  "./node_modules/@unifiedcommerce/plugin-*/dist/schema.js",
]
```

The `create-uc-app` CLI performs this rewrite automatically during scaffolding. The monorepo version continues to use relative paths for development.

#### 2.5.2 .env.template

Replace the stale Medusa-era template with UC-specific variables:

```env
# Database
DATABASE_URL=postgres://localhost:5432/my_store

# Auth
BETTER_AUTH_SECRET=  # Generate: openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:8000

# App
NEXT_PUBLIC_BASE_URL=http://localhost:8000

# Optional: Stripe (replace mock adapter)
# NEXT_PUBLIC_STRIPE_KEY=pk_test_...
# STRIPE_SECRET_KEY=sk_test_...

# Optional: Resend (replace console email adapter)
# RESEND_API_KEY=re_...
```

#### 2.5.3 next.config.js Adjustment

When installed from npm, `serverExternalPackages` remains the same -- the package names are identical whether workspace-linked or npm-installed. No change required.

#### 2.5.4 Package Export of Schema Files

For `drizzle.config.ts` to reference schema files from `node_modules`, the published packages must include the schema in their `exports`:

```json
// @unifiedcommerce/core package.json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "bun": "./src/index.ts",
      "import": "./dist/index.js"
    },
    "./schema": {
      "types": "./dist/kernel/database/schema.d.ts",
      "import": "./dist/kernel/database/schema.js"
    }
  }
}
```

Similarly, each plugin must export its schema:

```json
// @unifiedcommerce/plugin-gift-cards package.json
{
  "exports": {
    ".": { ... },
    "./schema": {
      "types": "./dist/schema.d.ts",
      "import": "./dist/schema.js"
    }
  }
}
```

This enables a cleaner drizzle.config.ts for standalone projects:

```typescript
schema: [
  "@unifiedcommerce/core/schema",
  "@unifiedcommerce/plugin-gift-cards/schema",
]
```

### 2.6 Docker Compose (Zero-Setup Evaluation)

For users who want to evaluate the fashion starter without installing Node.js, Bun, or PostgreSQL:

```yaml
# docker-compose.yml (shipped with the starter)
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: uc
      POSTGRES_PASSWORD: uc
      POSTGRES_DB: fashion_starter
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  app:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://uc:uc@db:5432/fashion_starter
      BETTER_AUTH_SECRET: docker-dev-secret-change-in-production
      NEXT_PUBLIC_BASE_URL: http://localhost:8000
    ports:
      - "8000:8000"
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

```dockerfile
# Dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM base AS runner
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/commerce.config.ts ./
COPY --from=build /app/next.config.js ./
COPY --from=build /app/src/scripts ./src/scripts

EXPOSE 8000
CMD ["bun", "run", "start"]
```

---

## 3. Implementation Plan

### Phase 1: Package Build Pipeline (2 days)

1. Install `tsup` as a devDependency in all 16 publishable packages
2. Create `tsup.config.ts` in each package with the shared pattern from Section 2.1.2
3. Update each `package.json`:
   - Remove `"private": true`
   - Add `"files": ["dist", "README.md"]`
   - Add `"publishConfig": { "access": "public" }`
   - Update `"exports"` to the dual `bun`/`import` pattern from Section 2.1.3
   - Add `"./schema"` export for core and plugin packages
4. Update `turbo.json` to use `tsup` in the build pipeline
5. Verify: `turbo run build` produces `dist/` in all 16 packages with `.js`, `.d.ts`, and `.js.map` files

### Phase 2: Changesets Setup (1 day)

1. `npx changeset init`
2. Write `.changeset/config.json` per Section 2.2.1
3. Add root scripts:
   ```json
   "version": "changeset version",
   "release": "turbo run build && changeset publish"
   ```
4. Create initial changeset: `npx changeset` -- select all 16 packages, `minor`, "Initial public release"
5. Run `npx changeset version` to bump all packages to `0.1.0`
6. Verify: all `package.json` files show `0.1.0`, `CHANGELOG.md` files generated

### Phase 3: CI Publishing Workflow (1 day)

1. Create `.github/workflows/release.yml` per Section 2.3.1
2. Create the `unifiedcommerce` npm organization
3. Generate npm automation token, add as `NPM_TOKEN` repository secret
4. Dry-run: push to main, verify the "Version Packages" PR is created
5. Merge the PR, verify all 16 packages appear on npmjs.com
6. Verify: `npm info @unifiedcommerce/core` returns the published package

### Phase 4: `create-uc-app` CLI (2 days)

1. Create `packages/create-uc-app/` with the code from Section 2.4.3
2. Add `create-uc-app` to the workspace and Changesets config
3. Implement the tar extraction + `package.json` rewrite + drizzle.config rewrite
4. Test locally: `node packages/create-uc-app/dist/index.js my-store --starter fashion`
5. Verify the scaffolded project installs and runs:
   ```bash
   cd my-store
   bun install
   bun run db:push
   bun run seed
   bun run dev
   ```
6. Publish `create-uc-app` to npm
7. Verify: `npx create-uc-app my-store` works from a clean machine

### Phase 5: Fashion Starter Standalone Preparation (1 day)

1. Update `.env.template` with UC-specific variables (Section 2.5.2)
2. Verify `drizzle.config.ts` rewrite logic handles all schema paths
3. Add `Dockerfile` and `docker-compose.yml` to the fashion starter
4. Test Docker build: `docker compose up --build`
5. Verify: store loads, seed runs, products display, checkout works

### Phase 6: Documentation (1 day)

1. Update `apps/docs/content/docs/installation.mdx` with the `create-uc-app` command
2. Update `apps/docs/content/docs/quickstart.mdx` to use the published packages
3. Add a `guides/custom-starter.mdx` explaining how to create a custom starter
4. Update changelog with RFC-021

---

## 4. Dependency Version Specifiers

The fashion starter's `package.json` uses `"*"` for all `@unifiedcommerce/*` dependencies. When the starter is scaffolded via `create-uc-app`, these are rewritten to `"^0.1.0"` (or whatever the current published version is). This pinning uses caret ranges, meaning:

- `^0.1.0` matches `>=0.1.0 <0.2.0` (before 1.0, minor bumps are breaking)
- After 1.0: `^1.2.0` matches `>=1.2.0 <2.0.0`

The existing workspace resolution (`"*"` and `"workspace:*"`) continues to work inside the monorepo. Only the scaffolded output uses pinned ranges.

---

## 5. Drizzle Schema Resolution in Standalone Mode

The most delicate part of the distribution pipeline is ensuring `drizzle-kit push` and `drizzle-kit generate` can find schema files from `node_modules`.

Drizzle-kit resolves `schema` paths relative to the config file. When a schema path points into `node_modules`, drizzle-kit must be able to:
1. Resolve the JavaScript module (not TypeScript -- the published package ships compiled output)
2. Find all `pgTable` exports

This works because drizzle-kit's `pushSchema` API (used in tests via `createPluginTestApp`) already accepts a merged schema object built from any source. The standalone `drizzle.config.ts` will use the `schema` array approach:

```typescript
// drizzle.config.ts (standalone)
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "@unifiedcommerce/core/schema",
    "@unifiedcommerce/plugin-gift-cards/schema",
  ],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

This requires that the `"./schema"` export in each package's `package.json` points to a module that exports all `pgTable` definitions.

---

## 6. Verification Checklist

1. `turbo run build` -- all 16 packages produce `dist/` with `.js`, `.d.ts`, `.js.map`
2. `npx changeset version` -- all packages bump to `0.1.0` with `CHANGELOG.md`
3. `npx changeset publish --dry-run` -- all 16 packages listed for publishing
4. `npm info @unifiedcommerce/core` -- package exists on npmjs.com
5. `npx create-uc-app my-store` -- scaffolds fashion starter with published deps
6. `cd my-store && bun install` -- all `@unifiedcommerce/*` packages resolve from npm
7. `bun run db:push` -- all tables created (core + plugin schemas found in node_modules)
8. `bun run seed` -- 10 products, 4 categories, 2 brands, 1 promotion
9. `bun run dev` -- store loads at localhost:8000, products display titles, Add to Cart works
10. `docker compose up --build` -- store runs in Docker with PostgreSQL
11. Full checkout flow: browse -> PDP -> add to cart -> checkout -> order in DB

---

## 7. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Drizzle-kit cannot resolve schema from node_modules | The `"./schema"` export path is tested before publishing. Fallback: ship a `drizzle.config.ts` that imports schemas programmatically and passes them to `pushSchema()`. |
| TypeScript declaration files have errors (tsup DTS generation) | Run `@arethetypeswrong/cli` against each published package in CI. Flag declaration errors before release. |
| Breaking change in core goes undetected by consumers | Fixed versioning (core + sdk always move together) prevents version skew. Changesets enforce explicit bump type selection. |
| GitHub tar extraction fails for large starters | Fashion starter is ~222 files, ~500KB uncompressed. Well within GitHub's tar API limits. The `giget` library handles this reliably -- it is the same approach used by Nuxt, Nitro, and UnJS ecosystem. |
| npm org `unifiedcommerce` is taken | Check availability before proceeding. Fallback: `@uc-engine` or `@venture-sell`. |
| Users on Node.js (not Bun) cannot run the starter | The starter uses `bun run dev` scripts. Add `"dev:node": "next dev -p 8000"` as an alternative. Published packages use ESM which works on Node.js 18+. |
