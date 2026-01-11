{{/*
Common template helpers for the Permoney chart
*/}}

{{- define "permoney.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "permoney.fullname" -}}
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

{{- define "permoney.labels" -}}
app.kubernetes.io/name: {{ include "permoney.name" . }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "permoney.selectorLabels" -}}
app.kubernetes.io/name: {{ include "permoney.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "permoney.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "permoney.serviceAccountName" -}}
{{- include "permoney.fullname" . -}}
{{- end -}}

{{/* Compute Rails DATABASE_URL if CNPG cluster is enabled and no override provided */}}
{{- define "permoney.databaseUrl" -}}
{{- $explicit := (index .Values.rails.extraEnv "DATABASE_URL") -}}
{{- if $explicit -}}
{{- $explicit -}}
{{- else -}}
{{- if .Values.cnpg.cluster.enabled -}}
{{- $cluster := .Values.cnpg.cluster.name | default (printf "%s-db" (include "permoney.fullname" .)) -}}
{{- $user := .Values.cnpg.cluster.appUser | default "permoney" -}}
{{- $db := .Values.cnpg.cluster.appDatabase | default "permoney" -}}
{{- printf "postgresql://%s:$(DB_PASSWORD)@%s-rw.%s.svc.cluster.local:5432/%s?sslmode=prefer" $user $cluster .Release.Namespace $db -}}
{{- else -}}
{{- "" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Compute Redis URL if no explicit override provided */}}
{{- define "permoney.redisUrl" -}}
{{- $explicit := (index .Values.rails.extraEnv "REDIS_URL") -}}
{{- if $explicit -}}
{{- $explicit -}}
{{- else -}}
  {{- if .Values.redisOperator.managed.enabled -}}
    {{- $name := .Values.redisOperator.name | default (printf "%s-redis" (include "permoney.fullname" .)) -}}
    {{- $host := printf "%s-master.%s.svc.cluster.local" $name .Release.Namespace -}}
    {{- printf "redis://default:$(REDIS_PASSWORD)@%s:6379/0" $host -}}
  {{- else if .Values.redisSimple.enabled -}}
    {{- $host := printf "%s-redis.%s.svc.cluster.local" (include "permoney.fullname" .) .Release.Namespace -}}
    {{- printf "redis://default:$(REDIS_PASSWORD)@%s:%d/0" $host (int (.Values.redisSimple.service.port | default 6379)) -}}
  {{- else -}}
    {{- "" -}}
  {{- end -}}
{{- end -}}
{{- end -}}

{{/* Check if Redis Sentinel is enabled and configured */}}
{{- define "permoney.redisSentinelEnabled" -}}
{{- if and .Values.redisOperator.managed.enabled .Values.redisOperator.sentinel.enabled (eq (.Values.redisOperator.mode | default "replication") "sentinel") -}}
true
{{- else -}}
{{- end -}}
{{- end -}}

{{/* Compute Redis Sentinel hosts (comma-separated list of host:port) */}}
{{- define "permoney.redisSentinelHosts" -}}
{{- if eq (include "permoney.redisSentinelEnabled" .) "true" -}}
  {{- $name := .Values.redisOperator.name | default (printf "%s-redis" (include "permoney.fullname" .)) -}}
  {{- $replicas := .Values.redisOperator.replicas | default 3 -}}
  {{- $port := .Values.redisOperator.probes.sentinel.port | default 26379 -}}
  {{- $hosts := list -}}
  {{- range $i := until (int $replicas) -}}
    {{- $host := printf "%s-sentinel-%d.%s-sentinel-headless.%s.svc.cluster.local:%d" $name $i $name $.Release.Namespace (int $port) -}}
    {{- $hosts = append $hosts $host -}}
  {{- end -}}
  {{- join "," $hosts -}}
{{- else -}}
{{- end -}}
{{- end -}}

{{/* Get Redis Sentinel master group name */}}
{{- define "permoney.redisSentinelMaster" -}}
{{- if eq (include "permoney.redisSentinelEnabled" .) "true" -}}
  {{- .Values.redisOperator.sentinel.masterGroupName | default "mymaster" -}}
{{- else -}}
{{- end -}}
{{- end -}}


{{/* Common secret name helpers to avoid complex inline conditionals in env blocks */}}
{{- define "permoney.appSecretName" -}}
{{- default (printf "%s-app" (include "permoney.fullname" .)) .Values.rails.existingSecret | default (printf "%s-app" (include "permoney.fullname" .)) -}}
{{- end -}}

{{- define "permoney.dbSecretName" -}}
{{- if .Values.cnpg.cluster.enabled -}}
  {{- if .Values.cnpg.cluster.existingSecret -}}
    {{- .Values.cnpg.cluster.existingSecret -}}
  {{- else -}}
    {{- default (printf "%s-db-app" (include "permoney.fullname" .)) .Values.cnpg.cluster.secret.name | default (printf "%s-db-app" (include "permoney.fullname" .)) -}}
  {{- end -}}
{{- else -}}
  {{- include "permoney.appSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "permoney.dbPasswordKey" -}}
{{- default "password" .Values.cnpg.cluster.secret.passwordKey -}}
{{- end -}}

{{- define "permoney.redisSecretName" -}}
  {{- if .Values.redisOperator.managed.enabled -}}
    {{- if .Values.redisOperator.auth.existingSecret -}}
      {{- .Values.redisOperator.auth.existingSecret -}}
    {{- else -}}
      {{- include "permoney.appSecretName" . -}}
    {{- end -}}
  {{- else if and .Values.redisSimple.enabled .Values.redisSimple.auth.enabled -}}
    {{- if .Values.redisSimple.auth.existingSecret -}}
      {{- .Values.redisSimple.auth.existingSecret -}}
    {{- else -}}
      {{- include "permoney.appSecretName" . -}}
    {{- end -}}
  {{- else -}}
    {{- include "permoney.appSecretName" . -}}
  {{- end -}}
{{- end -}}

{{- define "permoney.redisPasswordKey" -}}
  {{- if .Values.redisOperator.managed.enabled -}}
    {{- default "redis-password" .Values.redisOperator.auth.passwordKey -}}
  {{- else if and .Values.redisSimple.enabled .Values.redisSimple.auth.enabled -}}
    {{- default "redis-password" .Values.redisSimple.auth.passwordKey -}}
  {{- else -}}
    {{- default "redis-password" .Values.redis.passwordKey -}}
  {{- end -}}
{{- end -}}
