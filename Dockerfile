# syntax=docker/dockerfile:1.6
#
# Conversation Relay (TAC) — production container image.
#
# Two-stage build:
#   1. builder  installs all deps (incl. devDeps) and compiles TypeScript.
#   2. runtime  ships only the compiled output and production-only deps,
#               running as a non-root user with tini as PID 1 for proper
#               signal handling (so SIGTERM from the orchestrator gracefully
#               closes in-flight WebSocket connections instead of getting
#               eaten by node).
#
# Build:
#   docker build -t conversation-relay-tac .
#
# Run (provide env via your host's secret manager, NOT baked into the image):
#   docker run --rm -p 3000:3000 --env-file .env conversation-relay-tac

# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Manifests first to maximize layer caching when only source changes.
COPY package.json package-lock.json* ./

# `npm ci` is reproducible from the lockfile; cache the npm store across builds.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# Source + build config.
COPY tsconfig.json ./
COPY src ./src

# Compiles TS to dist/ and copies *.md prompts into dist/prompts/.
RUN npm run build

# Drop devDependencies so the runtime stage carries only what's needed.
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# tini for PID-1 signal handling. Without it, SIGTERM from Kubernetes / Fargate
# / Fly does not propagate cleanly into node and in-flight WSS connections die
# abruptly instead of draining.
RUN apk add --no-cache tini

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy production node_modules and compiled output. Skip src/, tests, docs.
COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist

USER app

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Liveness probe — most orchestrators (Fly, Render, ALB target groups, k8s)
# can be told to use this instead, but having it here means `docker run` /
# `docker compose` and basic platforms get a sensible default. Uses wget
# (already in the alpine base) rather than curl. 5s start period covers
# node's startup. Marked `--retries=3` so a brief blip won't restart-loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- --tries=1 http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
