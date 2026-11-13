# Claude Code Sessions Dashboard — container image.
#
# The app has zero runtime dependencies (Node built-ins only), so there is no
# install step: we just copy the source and run it. Node 22+ is required (see
# package.json "engines").
FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

WORKDIR /app

# Copy only what the server needs at runtime.
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# The server listens here; override with PORT if you like.
ENV PORT=4317
EXPOSE 4317

# Basic liveness: the state endpoint returns 200 once the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/state" || exit 1

CMD ["node", "server.js"]
