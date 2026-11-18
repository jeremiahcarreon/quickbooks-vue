# syntax=docker/dockerfile:1.7
#
# Builds the Vue SPA and serves it with nginx, proxying /api to the api service.
#   docker build -f docker/web.Dockerfile -t qbv/web .
# Runtime env: API_UPSTREAM (default http://api:3100).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# Root workspace member; only its manifest is needed for npm ci.
COPY e2e/package.json ./e2e/package.json
COPY schemas ./schemas
RUN --mount=type=cache,target=/root/.npm npm ci
# The SPA may import catalog metadata from @qbv/qbxml; generate it when the
# schemas are present in the context.
ENV QBXML_SCHEMA_DIR=/app/schemas/qbxml/17.0
RUN if [ -f schemas/qbxml/17.0/QBUqbxmlops170.xsd ]; then npm run codegen; fi
# The type check covers tests that import @qbv/qbxml, so build it first.
RUN npm run build -w @qbv/qbxml && npm run build -w @qbv/web

FROM ${NGINX_IMAGE} AS runtime
ENV API_UPSTREAM=http://api:3100
COPY docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
