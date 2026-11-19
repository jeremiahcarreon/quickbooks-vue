#!/usr/bin/env bash
# Builds every service image and pushes it to a private registry:
#   .github/scripts/build-push.sh <image-prefix> <tag>
# e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/qbv 3f2c1e0...
# Images contain the Intuit qbXML XSDs, so <image-prefix> must be private.
# No build cache is exported: cache entries would carry the XSD layers.
set -euo pipefail

prefix="${1:?image prefix required}"
tag="${2:?tag required}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

test -f "$root/schemas/qbxml/17.0/QBUqbxmlops170.xsd" || {
  echo "schemas/qbxml/17.0 is missing; restore the XSDs first" >&2
  exit 1
}

labels=(
  --label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:-jeremiahcarreon/quickbooks-vue}"
  --label "org.opencontainers.image.revision=${tag}"
)

for svc in api worker sync migrate relay-mock; do
  echo "::group::${svc}"
  docker buildx build "$root" -f "$root/docker/node.Dockerfile" \
    --build-arg "SERVICE=${svc}" "${labels[@]}" \
    --tag "${prefix}/${svc}:${tag}" --push
  echo "::endgroup::"
done

echo "::group::web"
docker buildx build "$root" -f "$root/docker/web.Dockerfile" "${labels[@]}" \
  --tag "${prefix}/web:${tag}" --push
echo "::endgroup::"
