FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# No .git in this build context (see .dockerignore) and husky is a dev-only
# concern; without this, `pnpm install`'s prepare script has nothing to
# install hooks into.
ENV HUSKY=0
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Dependencies for building. Split from the source copy so an app-code
# change doesn't re-resolve the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# tsconfig.build.json, not tsconfig.json: excludes tests and
# src/lib/testing.ts, which imports vitest and wouldn't resolve at runtime.
RUN pnpm build

# Runtime dependencies only, no dev tooling in the final image.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Kept so Node resolves the package as ESM and `node dist/src/lib/migrate.js` works.
COPY package.json ./

USER node
EXPOSE 3000

# Node 22 has global fetch, so this needs no curl/wget in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
