# Club booking server: one image serves the API, the LINE webhook and the built web app.
# Host-neutral: runs on any Docker host. See infra/README.md for deploy, backup and restore.
#
# Only named paths are copied (no `COPY . .`), so local node_modules, .data and .env files
# never reach the image even without a .dockerignore.

# ---- build: install all deps, build web (vite) then server (tsc) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund

COPY apps/server/tsconfig.json apps/server/tsconfig.build.json apps/server/drizzle.config.ts apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/
COPY apps/web/src apps/web/src
RUN npm run build

# Keep production dependencies only for the runtime stage.
RUN npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    API_PORT=8787 \
    DATA_DIR=/data
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist apps/server/dist
# Migrations run at start-up: dist/db/client.js reads ../../drizzle (= apps/server/drizzle).
COPY --from=build --chown=node:node /app/apps/server/drizzle apps/server/drizzle
# app.ts serves ../../web/dist (= apps/web/dist) when it exists.
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist

# DATA_DIR holds uploaded slips/media (and PGlite only when DATABASE_URL is unset).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
WORKDIR /app/apps/server
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8787)+'/health').then(r=>r.json()).then(j=>process.exit(j.ok===true?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
