# The API image (M8-38). Built from the repository root, because the workspace packages it uses are in the repository:
#
#   docker build -f apps/api/Dockerfile .
#
# Two stages. The first installs the workspace and bundles the server and the migrator with esbuild (`scripts/build.mjs`), which is what lets the second hold no
# dependencies at all: the workspace packages export TypeScript source and the application otherwise runs under `vite-node`, a development dependency, so "production
# dependencies only" is, here, "none, they are inside the bundle". The second stage is Node, the two bundles and the migrations, run as an unprivileged user.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN corepack pnpm install --frozen-lockfile --filter @questionbank/api...
RUN corepack pnpm --filter @questionbank/api exec node scripts/build.mjs

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 MIGRATIONS_DIR=/app/migrations MEDIA_STORAGE_ROOT=/var/media/files
RUN addgroup -S app && adduser -S app -G app && mkdir -p /var/media/files /var/media/mail && chown -R app:app /var/media
WORKDIR /app
COPY --from=build /repo/apps/api/dist/server.js /repo/apps/api/dist/migrate.js ./
COPY --from=build /repo/infra/migrations ./migrations
USER app
EXPOSE 3000
# liveness is `/healthz`, which asks nothing of the database (DEC-M0-9); the Compose file's healthcheck calls the same route
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 CMD wget -q -O /dev/null http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
