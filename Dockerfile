# syntax=docker/dockerfile:1
# Tavern: one Node process (Fastify + Socket.io + SQLite). The server runs its TypeScript
# directly (Node 22 type stripping), so the only build step is the web bundle.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY scripts scripts
# Build the bundle, then refuse to ship it if anything key-like ended up inside.
RUN pnpm --filter @tavern/web build && node scripts/check-bundle.mjs apps/web/dist

FROM base AS deps
# Production dependencies only (prebuilt better-sqlite3 and sharp binaries).
RUN pnpm install --frozen-lockfile --prod --filter @tavern/server... \
  && rm -rf /pnpm/store

FROM node:22-bookworm-slim AS app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data WEB_DIST=/app/apps/web/dist \
    NODE_OPTIONS=--max-old-space-size=768
WORKDIR /app
COPY --from=deps /app ./
COPY packages/shared packages/shared
COPY apps/server/src apps/server/src
COPY apps/server/migrations apps/server/migrations
COPY config config
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]
