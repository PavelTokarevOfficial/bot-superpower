FROM oven/bun:1.4.2-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json biome.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.2-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 bot && adduser --system --uid 1001 --ingroup bot bot
COPY --from=build --chown=bot:bot /app/dist ./dist

USER bot
CMD ["bun", "dist/index.js"]
