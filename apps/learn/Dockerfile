# The learner app image (M8-38). Built from the repository root:
#
#   docker build -f apps/learn/Dockerfile .
#
# `vite build`, then nginx serving the result with the API proxied at `/v1/` (apps/learn/nginx.conf, which says what the server must not do to the service worker and the signed packages).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN corepack pnpm install --frozen-lockfile --filter @questionbank/learn...
RUN corepack pnpm --filter @questionbank/learn build

FROM nginx:1.27-alpine
COPY apps/learn/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/learn/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
