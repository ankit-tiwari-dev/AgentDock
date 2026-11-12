# The AgentDock dashboard and its backend, reading one project's audit log.
# Build:  docker build -t agentdock .
# Run:    docker run --rm -p 127.0.0.1:45820:45820 -v /path/to/project:/project:ro agentdock
# Or:     AGENTDOCK_PROJECT_DIR=/path/to/project docker compose up --build
# Why the port is published to 127.0.0.1 and the project mounted read-only: docs/DECISIONS.md, D-4.

# Stage 1: build the dashboard into frontend/out. Nothing from this stage ships except that folder.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
# Manifests first, so a source change does not reinstall every package.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY extension/package.json extension/
RUN npm ci --no-audit --no-fund
COPY frontend frontend
RUN npm run build

# Stage 2: Node and the files the backend runs. The backend uses only Node's built-in modules, so there is no
# node_modules folder here.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
ENV NODE_ENV=production \
    AGENTDOCK_PROJECT=/project \
    AGENTDOCK_HOST=0.0.0.0 \
    AGENTDOCK_PORT=45820
COPY --chown=root:root package.json ./
COPY --chown=root:root backend/package.json backend/
COPY --chown=root:root backend/src backend/src
COPY --from=build --chown=root:root /src/frontend/out frontend/out
# The files belong to root and the server runs as `node`, so it cannot change its own code.
USER node
EXPOSE 45820
# fetch() sends Host: 127.0.0.1:<port>, which the backend's Host check accepts.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.AGENTDOCK_PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "backend/src/server.ts"]
