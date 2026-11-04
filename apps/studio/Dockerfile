# The Studio image (M8-38). Built from the repository root:
#
#   docker build -f apps/studio/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN corepack pnpm install --frozen-lockfile --filter @questionbank/studio...
RUN corepack pnpm --filter @questionbank/studio build

FROM nginx:1.27-alpine
COPY apps/studio/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/studio/dist /usr/share/nginx/html
EXPOSE 4173
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD wget -q --spider http://localhost:4173/ || exit 1
