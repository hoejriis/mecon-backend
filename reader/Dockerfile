# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f reader/Dockerfile -t mecon-reader .
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY reader/package.json reader/package-lock.json ./
RUN npm ci
COPY reader/ .
ARG RENDER_GIT_COMMIT
ENV RENDER_GIT_COMMIT=${RENDER_GIT_COMMIT}
RUN npm run build

FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS runtime
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/reader-headers.caddy /etc/caddy/reader-headers.caddy
COPY --from=build /app/dist /srv
# Caddy needs a writable home for its state; run as an unprivileged user.
RUN adduser -D -u 10001 reader && mkdir -p /data /config && chown -R reader /data /config
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
USER reader
EXPOSE 8080
