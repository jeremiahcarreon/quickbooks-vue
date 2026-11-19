{{/* vim: set filetype=mustache: */}}

{{- define "qbv.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "qbv.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "qbv.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Name of one component's objects: qbv.componentName (dict "root" $ "component" "api") */}}
{{- define "qbv.componentName" -}}
{{- printf "%s-%s" (include "qbv.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "qbv.labels" -}}
helm.sh/chart: {{ include "qbv.chart" . }}
{{ include "qbv.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: quickbooks-vue
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "qbv.selectorLabels" -}}
app.kubernetes.io/name: {{ include "qbv.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* qbv.componentLabels (dict "root" $ "component" "api") */}}
{{- define "qbv.componentLabels" -}}
{{ include "qbv.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "qbv.componentSelectorLabels" -}}
{{ include "qbv.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "qbv.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "qbv.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Image of an app service.
  qbv.image (dict "root" $ "service" "api" "values" .Values.api)
<prefix>/<service>:<tag>, where values.image.repository replaces
"<prefix>/<service>" and values.image.tag replaces the tag.
*/}}
{{- define "qbv.image" -}}
{{- $root := .root -}}
{{- $img := (.values.image | default dict) -}}
{{- $repo := $img.repository -}}
{{- if not $repo -}}
{{- if not $root.Values.image.prefix -}}
{{- fail "image.prefix is required (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/qbv), or set <service>.image.repository" -}}
{{- end -}}
{{- $repo = printf "%s/%s" (trimSuffix "/" $root.Values.image.prefix) .service -}}
{{- end -}}
{{- $tag := $img.tag | default $root.Values.image.tag | default $root.Chart.AppVersion -}}
{{- printf "%s:%s" $repo (toString $tag) -}}
{{- end -}}

{{- define "qbv.pullPolicy" -}}
{{- $img := (.values.image | default dict) -}}
{{- $img.pullPolicy | default .root.Values.image.pullPolicy | default "IfNotPresent" -}}
{{- end -}}

{{- define "qbv.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
{{- if kindIs "string" . }}
  - name: {{ . }}
{{- else }}
  - name: {{ .name }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Secret holding DATABASE_URL, REDIS_URL, SESSION_SECRET, RELAY_API_KEY, ADMIN_*. */}}
{{- define "qbv.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "qbv.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "qbv.postgresql.fullname" -}}
{{- include "qbv.componentName" (dict "root" . "component" "postgresql") -}}
{{- end -}}

{{- define "qbv.redis.fullname" -}}
{{- include "qbv.componentName" (dict "root" . "component" "redis") -}}
{{- end -}}

{{- define "qbv.redisUrl" -}}
{{- printf "redis://%s:6379/0" (include "qbv.redis.fullname" .) -}}
{{- end -}}

{{/* RELAY_URL: relay.url, else the in-chart relay mock. */}}
{{- define "qbv.relayUrl" -}}
{{- if .Values.relay.url -}}
{{- .Values.relay.url -}}
{{- else if .Values.relayMock.enabled -}}
{{- printf "http://%s:%d" (include "qbv.componentName" (dict "root" . "component" "relay-mock")) (int .Values.relayMock.service.port) -}}
{{- end -}}
{{- end -}}

{{/*
How migrations run.
  hook: Helm pre-install/pre-upgrade hook (external Postgres; production).
  job:  ordinary Job, apps wait for the schema in an init container
        (in-chart Postgres, which does not exist yet when pre-install hooks run).
*/}}
{{- define "qbv.migrateMode" -}}
{{- $mode := .Values.migrate.mode | default "auto" -}}
{{- if eq $mode "auto" -}}
{{- ternary "job" "hook" .Values.postgresql.enabled -}}
{{- else -}}
{{- $mode -}}
{{- end -}}
{{- end -}}

{{/* Secret the migrate Job reads: hook mode with a chart-made Secret uses a hook copy. */}}
{{- define "qbv.migrateSecretName" -}}
{{- if and (eq (include "qbv.migrateMode" .) "hook") (not .Values.secrets.existingSecret) -}}
{{- include "qbv.componentName" (dict "root" . "component" "migrate") -}}
{{- else -}}
{{- include "qbv.secretName" . -}}
{{- end -}}
{{- end -}}

{{/* SESSION_SECRET: value, else the one already in the cluster, else random. */}}
{{- define "qbv.sessionSecret" -}}
{{- if .Values.secrets.sessionSecret -}}
{{- .Values.secrets.sessionSecret -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "qbv.fullname" .) -}}
{{- if and $existing $existing.data (hasKey $existing.data "SESSION_SECRET") -}}
{{- index $existing.data "SESSION_SECRET" | b64dec -}}
{{- else -}}
{{- randAlphaNum 64 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "qbv.postgresql.password" -}}
{{- if .Values.postgresql.auth.password -}}
{{- .Values.postgresql.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "qbv.postgresql.fullname" .) -}}
{{- if and $existing $existing.data (hasKey $existing.data "POSTGRES_PASSWORD") -}}
{{- index $existing.data "POSTGRES_PASSWORD" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Checksum of the chart-made configuration, so pods roll when it changes. */}}
{{- define "qbv.configChecksum" -}}
{{- $cfg := include (print .Template.BasePath "/configmap.yaml") . -}}
{{- $sec := "" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- $sec = toYaml (omit .Values.secrets "existingSecret") -}}
{{- end -}}
{{- printf "%s\n%s\n%s" $cfg $sec (toYaml .Values.postgresql.auth) | sha256sum -}}
{{- end -}}

{{- define "qbv.podSecurityContext" -}}
{{- toYaml .Values.podSecurityContext -}}
{{- end -}}

{{- define "qbv.containerSecurityContext" -}}
{{- toYaml .Values.containerSecurityContext -}}
{{- end -}}

{{/*
Secret-sourced variables.
  qbv.secretEnv (dict "root" $ "keys" (list "DATABASE_URL" ...) "secretName" "...")
DATABASE_URL / REDIS_URL come from the in-chart Postgres / Redis when enabled.
*/}}
{{- define "qbv.secretEnv" -}}
{{- $root := .root -}}
{{- $secret := .secretName | default (include "qbv.secretName" $root) -}}
{{- $optional := list "RELAY_API_KEY" "ADMIN_EMAIL" "ADMIN_PASSWORD" -}}
{{- range .keys }}
{{- if and (eq . "DATABASE_URL") $root.Values.postgresql.enabled }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "qbv.postgresql.fullname" $root }}
      key: DATABASE_URL
{{- else if and (eq . "REDIS_URL") $root.Values.redis.enabled }}
- name: REDIS_URL
  value: {{ include "qbv.redisUrl" $root | quote }}
{{- else }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ . }}
      {{- if has . $optional }}
      optional: true
      {{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Init container that waits until every migration is applied (job mode only).
  qbv.waitForSchema (dict "root" $ "image" "..." "pullPolicy" "...")
*/}}
{{- define "qbv.waitForSchema" -}}
{{- if eq (include "qbv.migrateMode" .root) "job" }}
- name: wait-for-schema
  image: {{ .image }}
  imagePullPolicy: {{ .pullPolicy }}
  workingDir: /app
  command:
    - sh
    - -c
    - |
      echo "waiting for database migrations"
      i=0
      while :; do
        out="$(node packages/db/dist/cli/migrate.js status 2>&1)" && ! printf '%s\n' "$out" | grep -q '^pending' && break
        i=$((i+1))
        if [ $((i % 10)) -eq 0 ]; then printf '%s\n' "$out" | tail -n 3; fi
        sleep 3
      done
      echo "schema is up to date"
  env:
    - name: LOG_LEVEL
      value: warn
    {{- include "qbv.secretEnv" (dict "root" .root "keys" (list "DATABASE_URL")) | trim | nindent 4 }}
    {{- with .root.Values.config.DATABASE_SSL }}
    - name: DATABASE_SSL
      value: {{ . | quote }}
    {{- end }}
  securityContext:
    {{- include "qbv.containerSecurityContext" .root | nindent 4 }}
  resources:
    {{- toYaml .root.Values.migrate.resources | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
{{- end }}
{{- end -}}

{{/* Standard scheduling fields of a component. */}}
{{- define "qbv.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
{{- end -}}

{{/* Fail early on combinations that cannot work. */}}
{{- define "qbv.validate" -}}
{{- $mode := include "qbv.migrateMode" . -}}
{{- if not (has $mode (list "hook" "job")) -}}
{{- fail "migrate.mode must be auto, hook or job" -}}
{{- end -}}
{{- if and (eq $mode "hook") .Values.postgresql.enabled -}}
{{- fail "migrate.mode=hook cannot be used with postgresql.enabled=true: the in-chart Postgres does not exist yet when pre-install hooks run. Use migrate.mode=auto or job." -}}
{{- end -}}
{{- if not (include "qbv.relayUrl" .) -}}
{{- fail "relay.url is required (e.g. http://100.101.102.103:9123 over Tailscale), or enable relayMock for development" -}}
{{- end -}}
{{- if not .Values.secrets.existingSecret -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.secrets.databaseUrl) -}}
{{- fail "Set secrets.existingSecret, or secrets.databaseUrl, or postgresql.enabled=true" -}}
{{- end -}}
{{- if and (not .Values.redis.enabled) (not .Values.secrets.redisUrl) -}}
{{- fail "Set secrets.existingSecret, or secrets.redisUrl, or redis.enabled=true" -}}
{{- end -}}
{{- if and .Values.secrets.sessionSecret (lt (len .Values.secrets.sessionSecret) 32) -}}
{{- fail "secrets.sessionSecret must be at least 32 characters" -}}
{{- end -}}
{{- if and .Values.secrets.adminPassword (lt (len .Values.secrets.adminPassword) 12) -}}
{{- fail "secrets.adminPassword must be at least 12 characters" -}}
{{- end -}}
{{- end -}}
{{- end -}}
