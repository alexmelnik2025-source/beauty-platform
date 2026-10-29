FROM node:24-alpine AS build

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/config/package.json packages/config/package.json
RUN mkdir -p apps/api/src
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @beauty/api build

FROM build AS production-dependencies
RUN pnpm --filter @beauty/api --prod deploy --legacy --ignore-scripts /production

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /production ./
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist

USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main.js"]

# Run migrations explicitly with the maintenance profile; API startup never migrates data.
FROM build AS migrate
ENV NODE_ENV=production HOME=/tmp
USER node
CMD ["pnpm", "--filter", "@beauty/api", "db:deploy"]
