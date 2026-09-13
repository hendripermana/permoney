# =============================================================================
# Permoney — production image (PER-192)
# =============================================================================
# Two stages: build the Nitro standalone server (`vp build`, see ADR-0003 and
# docs/adr/0047-self-hosted-production-postgres.md), then ship only the
# traced `.output/` runtime — no repo source, no build toolchain, no dev
# dependencies in the final image.
#
# ARM64 NOTE (read before rebuilding on a different host): this image bundles
# native modules (e.g. @node-rs/argon2's Better-Auth password hasher) that
# `pnpm install` resolves to a platform-specific prebuilt binary. The image
# MUST be built ON (or natively for) the target architecture — the Oracle VM
# is aarch64/arm64. Do NOT build on an x86_64 machine and copy `.output`
# over; the traced node_modules will contain an x64 .node binary that fails
# to load on the arm64 host. Build with `docker build .` run directly on the
# arm64 VM (no cross-emulation needed, since host arch == target arch), or
# with `docker buildx build --platform linux/arm64` if building elsewhere.
#
# Mirrors .github/workflows/ci.yml's toolchain exactly: Node 24, pnpm via
# corepack (packageManager pin in package.json), `pnpm install
# --frozen-lockfile` (postinstall runs `prisma generate`), `pnpm run build`
# (= `vp build`).
# =============================================================================

FROM node:24-bookworm-slim AS build
WORKDIR /app

# git: the package.json "prepare" lifecycle script (`vp config`) shells out to
# git. openssl: Prisma's engine-selection at `prisma generate` time probes
# libssl and silently defaults to the wrong variant without it (CI's
# ubuntu-latest runners have both preinstalled already, which is why this
# never surfaced there).
RUN apt-get update && apt-get install -y --no-install-recommends git openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Layer-cache dependency install separately from source changes.
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# Prisma's query engine binary needs libssl at RUNTIME too, not just at
# `prisma generate` time — same reason as the build stage.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3005

# Non-root runtime user (the official node image ships a `node` user/group).
COPY --from=build --chown=node:node /app/.output ./.output

USER node
EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3005) +'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
