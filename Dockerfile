# Claude Code Sessions Dashboard — container image.
#
# The app has zero runtime dependencies (Node built-ins only), so there is no
# install step: we just copy the source and run it. Node 22+ is required (see
# package.json "engines").
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

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
