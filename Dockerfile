FROM oven/bun:alpine

ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV

WORKDIR /app

COPY ./package.json ./bun.lock /app/

RUN bun install --frozen-lockfile --production --omit=peer

ARG CACHE_BUST

COPY . /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const port = process.env.PORT ?? '3000'; try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (!response.ok) process.exit(1); } catch { process.exit(1); }"]

ENTRYPOINT ["bun", "/app/index.ts"]
