FROM node:22-slim AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY src/ src/
COPY data/ data/
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs ./
COPY public/ public/

# Build
RUN npm run build

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
