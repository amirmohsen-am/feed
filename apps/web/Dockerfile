FROM node:22-slim AS base

WORKDIR /app

RUN npm install -g pnpm@11.0.8

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY src/ src/
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs ./
COPY public/ public/

# Build
RUN pnpm build

# Production
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=base /app/.next/standalone ./
COPY --from=base /app/.next/static ./.next/static
COPY --from=base /app/public ./public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
