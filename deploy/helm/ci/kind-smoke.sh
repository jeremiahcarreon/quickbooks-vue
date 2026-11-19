#!/usr/bin/env bash
# Smoke test of the Helm chart on kind.
#
# Assumes a kind cluster exists, the current kube-context points at it, and the
# images qbv/<service>:ci are loaded (deploy/helm/ci/build-images.sh <cluster>).
#
#   deploy/helm/ci/kind-smoke.sh [--keep-forwarding] [-- extra helm args...]
#   deploy/helm/ci/kind-smoke.sh --stop-forwarding
#
# Steps: helm upgrade --install with ci/kind-values.yaml (--wait), wait for every
# rollout, port-forward web and relay-mock to localhost, check GET /api/health,
# log in as the CI admin, and wait until the initial sync has put Customers in
# the read model. On failure it dumps the namespace (resources, events, pod
# descriptions and logs).
#
# --keep-forwarding  leave the port-forwards running after a successful run (for
#                    a following Playwright step); their PIDs are in $PF_PID_FILE.
#                    Stop them with --stop-forwarding (or kill "$(cat "$PF_PID_FILE")").
#
# Environment (defaults):
#   RELEASE=qbv  NAMESPACE=qbv
#   WEB_PORT=8180  RELAY_MOCK_PORT=9223   local ports of the port-forwards
#   HELM_TIMEOUT=10m  SYNC_TIMEOUT=300     (seconds) wait for the initial sync
#   ADMIN_EMAIL=admin@example.com  ADMIN_PASSWORD=dev-admin-password
#   RELAY_API_KEY=dev-relay-key
#   PF_PID_FILE=${RUNNER_TEMP:-/tmp}/qbv-port-forward.pids
#   PF_LOG_DIR=${RUNNER_TEMP:-/tmp}       port-forward logs
#   FORWARD_MODE=auto    docker | kubectl | auto (docker when the kind node
#                        container is found and the Service is a NodePort)
#   KIND_CLUSTER         kind cluster name (default: from the kube-context kind-<name>)
#   SOCAT_IMAGE=alpine/socat:1.8.0.0
#   HELM=helm  KUBECTL=kubectl  DOCKER=docker
#
# Forwarding: in docker mode each local port is a small socat container on the
# "kind" Docker network, published on 127.0.0.1, that connects to the Service's
# NodePort on the kind node (ci/kind-values.yaml sets fixed NodePorts). It is
# robust under browser traffic. kubectl mode runs `kubectl port-forward` under a
# supervisor that restarts it when it stops answering. $PF_PID_FILE lists one
# entry per forward: a PID, or docker:<container>.
set -euo pipefail

RELEASE="${RELEASE:-qbv}"
NAMESPACE="${NAMESPACE:-qbv}"
WEB_PORT="${WEB_PORT:-8180}"
RELAY_MOCK_PORT="${RELAY_MOCK_PORT:-9223}"
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"
SYNC_TIMEOUT="${SYNC_TIMEOUT:-300}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-dev-admin-password}"
RELAY_API_KEY="${RELAY_API_KEY:-dev-relay-key}"
TMP_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
PF_PID_FILE="${PF_PID_FILE:-${TMP_BASE}/qbv-port-forward.pids}"
PF_LOG_DIR="${PF_LOG_DIR:-${TMP_BASE}}"
HELM="${HELM:-helm}"
DOCKER="${DOCKER:-docker}"
FORWARD_MODE="${FORWARD_MODE:-auto}"
SOCAT_IMAGE="${SOCAT_IMAGE:-alpine/socat:1.8.0.0}"
# kubectl's SPDY port-forward drops the whole tunnel after a client resets a
# connection (browsers do this); the WebSocket transport (default from kubectl
# 1.31, opt-in on 1.30) does not.
export KUBECTL_PORT_FORWARD_WEBSOCKETS="${KUBECTL_PORT_FORWARD_WEBSOCKETS:-true}"
KUBECTL="${KUBECTL:-kubectl}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART="${HERE}/../quickbooks-vue"
VALUES="${CHART}/ci/kind-values.yaml"

KEEP_FORWARDING=0
EXTRA_HELM_ARGS=()

log() { printf '[kind-smoke] %s\n' "$*" >&2; }

stop_forwarding() {
  if [[ -f "$PF_PID_FILE" ]]; then
    local entry
    while read -r entry; do
      case "$entry" in
        "") ;;
        docker:*) "$DOCKER" rm -f "${entry#docker:}" >/dev/null 2>&1 || true ;;
        *) kill "$entry" 2>/dev/null || true ;;
      esac
    done <"$PF_PID_FILE"
    rm -f "$PF_PID_FILE"
    log "stopped port-forwards"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-forwarding) KEEP_FORWARDING=1 ;;
    --stop-forwarding)
      stop_forwarding
      exit 0
      ;;
    --)
      shift
      EXTRA_HELM_ARGS=("$@")
      break
      ;;
    -h | --help)
      sed -n '2,39p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      log "unknown argument: $1"
      exit 2
      ;;
  esac
  shift
done

k() { "$KUBECTL" -n "$NAMESPACE" "$@"; }

dump_diagnostics() {
  log "==================== diagnostics (namespace ${NAMESPACE}) ===================="
  k get all,jobs,pvc,networkpolicy -o wide || true
  log "---- events"
  k get events --sort-by=.lastTimestamp | tail -n 80 || true
  local pod
  for pod in $(k get pods -o name 2>/dev/null); do
    local phase ready
    phase="$(k get "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    ready="$(k get "$pod" -o jsonpath='{.status.containerStatuses[*].ready}' 2>/dev/null || true)"
    if [[ "$phase" == "Succeeded" ]] || { [[ -n "$ready" ]] && [[ "$ready" != *false* ]]; }; then
      continue
    fi
    log "---- describe ${pod} (not ready)"
    k describe "$pod" || true
  done
  for pod in $(k get pods -o name 2>/dev/null); do
    log "---- logs ${pod}"
    k logs "$pod" --all-containers --prefix --tail=300 || true
    k logs "$pod" --all-containers --prefix --previous --tail=100 2>/dev/null || true
  done
  for f in "${PF_LOG_DIR}/qbv-pf-web.log" "${PF_LOG_DIR}/qbv-pf-relay-mock.log"; do
    [[ -f "$f" ]] && { log "---- ${f}"; tail -n 50 "$f" || true; }
  done
  log "==================== end of diagnostics ===================="
}

JAR=""
on_exit() {
  local rc=$?
  [[ -n "$JAR" ]] && rm -f "$JAR"
  if [[ $rc -ne 0 ]]; then
    log "FAILED (exit ${rc})"
    dump_diagnostics
    stop_forwarding
  elif [[ $KEEP_FORWARDING -eq 1 ]]; then
    log "port-forwards left running (PIDs in ${PF_PID_FILE}); stop with: $0 --stop-forwarding"
  else
    stop_forwarding
  fi
  exit "$rc"
}
trap on_exit EXIT

for bin in "$HELM" "$KUBECTL" curl; do
  command -v "$bin" >/dev/null || {
    log "missing required command: $bin"
    exit 1
  }
done

log "context: $("$KUBECTL" config current-context)"
stop_forwarding

log "helm upgrade --install ${RELEASE} (namespace ${NAMESPACE}, timeout ${HELM_TIMEOUT})"
"$HELM" upgrade --install "$RELEASE" "$CHART" \
  --namespace "$NAMESPACE" --create-namespace \
  -f "$VALUES" \
  --wait --timeout "$HELM_TIMEOUT" \
  ${EXTRA_HELM_ARGS[@]+"${EXTRA_HELM_ARGS[@]}"}

selector="app.kubernetes.io/instance=${RELEASE}"
log "waiting for rollouts"
for res in $(k get deploy,statefulset -l "$selector" -o name); do
  k rollout status "$res" --timeout=300s
done
for job in $(k get jobs -l "${selector},app.kubernetes.io/component=migrate" -o name); do
  k wait --for=condition=complete "$job" --timeout=300s
done

svc_for() {
  k get svc -l "${selector},app.kubernetes.io/component=$1" -o jsonpath='{.items[0].metadata.name}'
}
web_svc="$(svc_for web)"
mock_svc="$(svc_for relay-mock)"
web_svc_port="$(k get svc "$web_svc" -o jsonpath='{.spec.ports[0].port}')"
mock_svc_port="$(k get svc "$mock_svc" -o jsonpath='{.spec.ports[0].port}')"

# One supervised port-forward. kubectl port-forward can wedge ("error creating
# forwarding stream ... Timeout occurred") after a client drops a connection,
# and it exits when the pod goes away, so a supervisor probes the local port
# every PF_PROBE_INTERVAL seconds and restarts kubectl when it stops answering.
# The supervisor's PID goes to $PF_PID_FILE; killing it (TERM) stops kubectl too.
supervise_forward() {
  local svc=$1 local_port=$2 remote_port=$3
  local pf="" fails=0
  trap 'if [[ -n "$pf" ]]; then kill "$pf" 2>/dev/null; fi; exit 0' TERM INT HUP
  while :; do
    "$KUBECTL" -n "$NAMESPACE" port-forward "svc/${svc}" "${local_port}:${remote_port}" &
    pf=$!
    fails=0
    while kill -0 "$pf" 2>/dev/null; do
      sleep "${PF_PROBE_INTERVAL:-5}" &
      wait $! || true
      # Any HTTP status (even 401/404) proves the tunnel works; 000 means it does not.
      if [[ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${local_port}/" || true)" == "000" ]]; then
        fails=$((fails + 1))
        if ((fails >= 2)); then
          echo "[supervisor] localhost:${local_port} is not answering; restarting kubectl port-forward"
          kill "$pf" 2>/dev/null || true
        fi
      else
        fails=0
      fi
    done
    wait "$pf" 2>/dev/null || true
    sleep 1 &
    wait $! || true
  done
}

kind_node() {
  local cluster="${KIND_CLUSTER:-}"
  if [[ -z "$cluster" ]]; then
    cluster="$("$KUBECTL" config current-context)"
    cluster="${cluster#kind-}"
  fi
  printf '%s-control-plane' "$cluster"
}

# docker mode: socat container on the kind network -> <node>:<nodePort>.
start_docker_forward() {
  local name=$1 node_port=$2 local_port=$3 node
  node="$(kind_node)"
  local container="qbv-fwd-${NAMESPACE}-${name}"
  "$DOCKER" rm -f "$container" >/dev/null 2>&1 || true
  "$DOCKER" run -d --rm --name "$container" --network kind \
    -p "127.0.0.1:${local_port}:${local_port}" "$SOCAT_IMAGE" \
    "TCP-LISTEN:${local_port},fork,reuseaddr" "TCP:${node}:${node_port}" >/dev/null
  echo "docker:${container}" >>"$PF_PID_FILE"
  log "forward ${name}: 127.0.0.1:${local_port} -> ${node}:${node_port} (NodePort, container ${container})"
}

start_forward() {
  local name=$1 svc=$2 local_port=$3 remote_port=$4
  local logf="${PF_LOG_DIR}/qbv-pf-${name}.log"
  local mode="$FORWARD_MODE" node_port=""
  if [[ "$mode" != "kubectl" ]]; then
    node_port="$(k get svc "$svc" -o jsonpath='{.spec.ports[0].nodePort}')"
    if [[ "$mode" == "auto" ]]; then
      if [[ -n "$node_port" ]] && command -v "$DOCKER" >/dev/null &&
        "$DOCKER" inspect "$(kind_node)" >/dev/null 2>&1; then
        mode=docker
      else
        mode=kubectl
      fi
    elif [[ -z "$node_port" ]]; then
      log "FORWARD_MODE=docker needs svc/${svc} to be a NodePort"
      return 1
    fi
  fi
  if [[ "$mode" == "docker" ]]; then
    start_docker_forward "$name" "$node_port" "$local_port"
    return
  fi
  # nohup: keeps running after this script exits (--keep-forwarding).
  # kubectl binds localhost (127.0.0.1 and ::1 when available).
  nohup bash -c "$(declare -f supervise_forward); KUBECTL=$(printf '%q' "$KUBECTL") NAMESPACE=$(printf '%q' "$NAMESPACE") supervise_forward $(printf '%q ' "$svc" "$local_port" "$remote_port")" \
    >"$logf" 2>&1 &
  echo $! >>"$PF_PID_FILE"
  log "port-forward ${name}: localhost:${local_port} -> svc/${svc}:${remote_port} (supervisor pid $!, log ${logf})"
}

mkdir -p "$(dirname "$PF_PID_FILE")" "$PF_LOG_DIR"
: >"$PF_PID_FILE"
start_forward web "$web_svc" "$WEB_PORT" "$web_svc_port"
start_forward relay-mock "$mock_svc" "$RELAY_MOCK_PORT" "$mock_svc_port"

BASE="http://127.0.0.1:${WEB_PORT}"
MOCK="http://127.0.0.1:${RELAY_MOCK_PORT}"

# retry <seconds> <description> <command...>
retry() {
  local timeout=$1 what=$2
  shift 2
  local deadline=$((SECONDS + timeout))
  until "$@"; do
    if ((SECONDS >= deadline)); then
      log "timed out after ${timeout}s: ${what}"
      return 1
    fi
    sleep 3
  done
}

health_ok() {
  local body
  body="$(curl -fsS --max-time 10 "${BASE}/api/health")" || return 1
  grep -q '"status":"ok"' <<<"$body" || return 1
  log "health: ${body}"
}
retry 120 "GET /api/health returns status ok" health_ok

mock_ok() { curl -fsS --max-time 10 -H "x-api-key: ${RELAY_API_KEY}" "${MOCK}/qb/health" >/dev/null; }
retry 60 "relay mock /qb/health through the port-forward" mock_ok
log "relay mock reachable at ${MOCK}"

curl -fsS --max-time 10 "${BASE}/" | grep -qi '<div id="app"\|<!doctype html' || {
  log "web did not serve the SPA index"
  exit 1
}

JAR="$(mktemp "${TMP_BASE}/qbv-cookies.XXXXXX")"
login() {
  local code
  code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -c "$JAR" \
    -H 'content-type: application/json' \
    --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    "${BASE}/api/auth/login")" || return 1
  [[ "$code" == 2* ]] || {
    log "login -> HTTP ${code}"
    return 1
  }
}
retry 60 "admin login" login
log "logged in as ${ADMIN_EMAIL}"

customers_synced() {
  local body total
  body="$(curl -fsS --max-time 15 -b "$JAR" "${BASE}/api/objects/Customer?pageSize=1")" || return 1
  total="$(grep -o '"total":[0-9]*' <<<"$body" | head -n1 | cut -d: -f2)"
  [[ -n "$total" && "$total" -gt 0 ]] || return 1
  log "initial sync done: ${total} customers in the read model"
}
log "waiting up to ${SYNC_TIMEOUT}s for the initial sync"
retry "$SYNC_TIMEOUT" "Customer list populated by the initial sync" customers_synced
log "OK: web http://localhost:${WEB_PORT}  relay-mock http://127.0.0.1:${RELAY_MOCK_PORT}"
