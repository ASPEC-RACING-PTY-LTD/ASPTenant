FROM node:22.20.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web ./apps/web
COPY apps/api/package.json ./apps/api/package.json
COPY packages/tsconfig.base.json ./packages/tsconfig.base.json
COPY packages/aspec ./packages/aspec
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @aspectenant/web build

FROM nginx:1.28-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=10s \
  CMD wget -qO- http://127.0.0.1/livez >/dev/null || exit 1
