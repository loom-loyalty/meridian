# Multi-stage build: compile TS in a build image, ship a lean runtime image.

FROM node:22-alpine AS build
WORKDIR /app

# Copy the whole monorepo context so workspace deps resolve. Adopters
# repackaging this pattern for their own standalone agent should swap
# to a simpler single-package Dockerfile — the workspace-copy step is
# only here because the example lives inside the Meridian monorepo.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/types/package.json packages/types/package.json
COPY examples/docker-kafka/package.json examples/docker-kafka/package.json

RUN corepack enable && pnpm install --frozen-lockfile --filter "@meridian/example-docker-kafka..."

COPY packages/types packages/types
COPY examples/docker-kafka examples/docker-kafka
COPY tsconfig.base.json ./

RUN pnpm --filter "@meridian/example-docker-kafka..." build

# Runtime image — ships only the compiled output + prod deps.
FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/types ./packages/types
COPY --from=build /app/examples/docker-kafka ./examples/docker-kafka

WORKDIR /app/examples/docker-kafka

# Non-root user for hardening.
RUN addgroup -S meridian && adduser -S meridian -G meridian
USER meridian

# Graceful-shutdown path: the agent handles SIGTERM to DELETE its
# Meridian agent before exiting. Docker sends SIGTERM on `docker stop`,
# waits 10s by default, then SIGKILL. If your terminate RPC takes
# longer than 10s, bump `--stop-timeout`.
STOPSIGNAL SIGTERM

CMD ["node", "dist/src/agent.js"]
