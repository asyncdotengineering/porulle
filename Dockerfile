# Single-stage Dockerfile for store-example deployed to Fly.
#
# Packages are managed with pnpm (matching the repo); the app is *run* with
# bun, because core's package.json `exports` resolves the "bun" condition to
# src/*.ts directly — bun executes TypeScript natively, so no compile step is
# needed. PGlite (a test-only dependency) is never loaded at runtime because
# nothing on the production code path imports core/src/test-utils/.

FROM oven/bun:1.2

WORKDIR /app

# pnpm is the package manager; install it once on the bun base image.
RUN bun install -g pnpm@10.33.0

# Workspace manifests first to maximize cache hits on dep changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages packages
# All apps' package.json so the lockfile resolves every workspace member.
# pnpm install --frozen-lockfile fails otherwise.
COPY apps apps
# Release scripts (db migration runner, smoke probes) — invoked by Fly's
# release_command which runs from the image WORKDIR.
COPY scripts scripts

RUN pnpm install --frozen-lockfile

# Media uploads land here. In production this should be an external
# volume or object store; the local-storage adapter writes inside the
# container FS otherwise.
RUN mkdir -p /app/apps/store-example/.data/media

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/apps/store-example

CMD ["bun", "src/server.ts"]
