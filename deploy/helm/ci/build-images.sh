#!/usr/bin/env bash
# Builds the six QuickBooks Vue images as qbv/<service>:<tag> from the repo
# Dockerfiles and loads them into a kind cluster.
#
#   deploy/helm/ci/build-images.sh [cluster-name]      (default cluster: qbv)
#
# Environment:
#   IMAGE_PREFIX   image prefix                (default qbv)
#   IMAGE_TAG      image tag                   (default ci)
#   SERVICES       space-separated subset      (default: all six)
#   SKIP_LOAD=1    build only, do not `kind load`
#   KIND           kind binary                 (default kind)
#   DOCKER         docker binary               (default docker)
#
# The build context must contain schemas/qbxml/17.0/*.xsd (Intuit-licensed,
# never committed). Images built here contain them: keep them private.
set -euo pipefail

CLUSTER="${1:-qbv}"
PREFIX="${IMAGE_PREFIX:-qbv}"
TAG="${IMAGE_TAG:-ci}"
SERVICES="${SERVICES:-api worker sync migrate relay-mock web}"
KIND="${KIND:-kind}"
DOCKER="${DOCKER:-docker}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

if [[ ! -f schemas/qbxml/17.0/QBUqbxmlops170.xsd ]]; then
  echo "schemas/qbxml/17.0/QBUqbxmlops170.xsd is missing; the images cannot be built (see docs/DESIGN.md section 4)." >&2
  exit 1
fi

export DOCKER_BUILDKIT=1
images=()
for svc in $SERVICES; do
  image="${PREFIX}/${svc}:${TAG}"
  echo "==> building ${image}"
  if [[ "$svc" == "web" ]]; then
    "$DOCKER" build -f docker/web.Dockerfile -t "$image" .
  else
    "$DOCKER" build -f docker/node.Dockerfile --build-arg "SERVICE=${svc}" -t "$image" .
  fi
  images+=("$image")
done

if [[ "${SKIP_LOAD:-0}" == "1" ]]; then
  echo "==> SKIP_LOAD=1: not loading into kind"
  exit 0
fi

echo "==> loading ${#images[@]} images into kind cluster ${CLUSTER}"
"$KIND" load docker-image --name "$CLUSTER" "${images[@]}"
echo "==> done"
