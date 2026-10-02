FROM node:22.20.0-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/tsconfig.base.json ./packages/tsconfig.base.json
COPY packages/aspec ./packages/aspec
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @aspec/errors --filter @aspec/validation --filter @aspec/api --filter @aspec/config --filter @aspec/db --filter @aspec/observability --filter @aspec/auth --filter @aspec/users --filter @aspec/orgs --filter @aspec/rbac --filter @aspec/audit --filter @aspec/rate-limit build
RUN pnpm --filter @aspectenant/api build
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
RUN mkdir -p /updates && chown node:node /updates
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
