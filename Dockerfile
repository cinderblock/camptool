# syntax=docker/dockerfile:1

# --- Build stage: install all deps and produce the React Router build ---
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- Runtime stage: prod deps + build output + the socket server ---
FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/build ./build
# Migrations are read from disk at startup (db/client.server.ts), so ship them.
COPY db ./db
COPY server.ts ./

CMD ["bun", "run", "server.ts"]
