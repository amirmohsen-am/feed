FROM node:22-slim

WORKDIR /app

RUN npm install -g pnpm@11.0.8

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["pnpm", "start"]
