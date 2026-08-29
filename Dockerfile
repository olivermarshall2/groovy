# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV CI=true

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --filter @mp3-platform/server... --filter @mp3-platform/web...

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/shared packages/shared

RUN pnpm --filter @mp3-platform/shared build \
  && pnpm --filter @mp3-platform/web build \
  && pnpm --filter @mp3-platform/server build \
  && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=4318 \
  DATABASE_PATH=/data/library.db \
  SCAN_INTERVAL_MINUTES=15

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /music /books \
  && chown -R node:node /data /music /books /app

COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist

USER node

EXPOSE 4318

VOLUME ["/data", "/music", "/books"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4318/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
