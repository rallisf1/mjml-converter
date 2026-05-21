FROM oven/bun:alpine

ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV

WORKDIR /app

COPY ./package.json ./bun.lock /app/

RUN bun install --frozen-lockfile --production --omit=peer

ARG CACHE_BUST

COPY . /app

ENTRYPOINT ["bun", "/app/index.ts"]
