# syntax=docker/dockerfile:1

# --- Build stage: install all deps and produce the React Router build ---
FROM oven/bun:1.3 AS build
WORKDIR /app
# Workspace manifests must be present before install so `workspace:*` resolves.
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
COPY . .
# Which camp-theme package to bake into the bundle (build-time; default = the
# built-in theme). Override per deployment: `docker build --build-arg CAMP_THEME=…`
# or via compose (see compose.yaml). See app/theme + vite.config.ts.
ARG CAMP_THEME=@camptool/default-theme
ENV CAMP_THEME=$CAMP_THEME
RUN bun run build

# --- Runtime stage: prod deps + build output + the socket server ---
FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production
COPY --from=build /app/build ./build
# Migrations are read from disk at startup (db/client.server.ts), so ship them.
COPY db ./db
COPY server.ts ./

# Stamp what this image is, for the two things that ask:
#   BUILD_SHA   — server.ts serves it at /_version
#   BUILD_THEME — which camp-theme Vite actually baked in
ARG GIT_SHA=unknown
ARG CAMP_THEME=@camptool/default-theme
RUN printf '%s' "${GIT_SHA}" > /app/BUILD_SHA \
	&& printf '%s' "${CAMP_THEME}" > /app/BUILD_THEME

# The theme is a BUILD input, so it is invisible in a digest and in the
# runtime env. Publishing it as a label lets ops assert it: the deployment's
# pin.json carries the expected value and the deploy refuses a mismatch,
# which is what the old on-host bundle-vs-container comparison did.
LABEL us.mathcamp.camptool.theme="${CAMP_THEME}"

CMD ["bun", "run", "server.ts"]
