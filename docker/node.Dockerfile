# syntax=docker/dockerfile:1.7
#
# Builds one Node service of the monorepo (apps/<SERVICE>), or only the
# shared packages when apps/<SERVICE> does not exist (e.g. SERVICE=migrate).
#
#   docker build -f docker/node.Dockerfile --build-arg SERVICE=api -t qbv/api .
#
# The build context must contain schemas/qbxml/17.0/*.xsd: codegen runs from
# them and validation needs them at runtime. Those files are Intuit-licensed,
# so images built from this file are for private use only; never push them
# to a public registry.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG SERVICE
RUN test -n "$SERVICE" || (echo "Build arg SERVICE is required (api, worker, sync, relay-mock, migrate)" && exit 1)
WORKDIR /app
ENV CI=true \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
# Root workspace member; only its manifest is needed for npm ci.
COPY e2e/package.json ./e2e/package.json
COPY schemas ./schemas
COPY tsconfig.base.json ./

RUN test -f schemas/qbxml/17.0/QBUqbxmlops170.xsd || \
    (echo "schemas/qbxml/17.0/QBUqbxmlops170.xsd is missing from the build context (see docs/DESIGN.md section 4)" && exit 1)

RUN --mount=type=cache,target=/root/.npm npm ci

ENV QBXML_SCHEMA_DIR=/app/schemas/qbxml/17.0
RUN npm run codegen

# Shared packages (alphabetical order respects their dependencies), then the service.
RUN set -e; \
    for d in packages/*/; do \
      if [ -f "$d/package.json" ]; then npm run build --if-present -w "./${d%/}"; fi; \
    done; \
    mkdir -p "apps/$SERVICE"; \
    if [ -f "apps/$SERVICE/package.json" ]; then npm run build --if-present -w "./apps/$SERVICE"; fi

RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production \
    QBXML_SCHEMA_DIR=/app/schemas/qbxml/17.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/schemas ./schemas
COPY --from=build /app/apps/${SERVICE} ./apps/${SERVICE}
# Writable data directory for services that keep local state (relay-mock's
# MOCK_DATA_FILE). A named volume mounted here inherits the node ownership.
RUN mkdir -p /app/data && chown node:node /app/data
WORKDIR /app/apps/${SERVICE}
USER node
# Each app defines `npm start`. Compose runs it with `init: true` so signals reach node.
CMD ["npm", "run", "start", "--silent"]
