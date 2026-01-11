# Changelog

All notable changes to the Permoney Helm chart will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-10

### Added
- Initial Permoney Helm chart import with Permoney defaults and naming.
- CNPG: render `Cluster.spec.backup` from `cnpg.cluster.backup`.
  - If `backup.method` is omitted and `backup.volumeSnapshot` is present, the chart will infer `method: volumeSnapshot`.
  - For snapshot backups, `backup.volumeSnapshot.className` is required (template fails early if missing).
  - Example-only keys like `backup.ttl` and `backup.volumeSnapshot.enabled` are stripped to avoid CRD warnings.
- CNPG: render `Cluster.spec.plugins` from `cnpg.cluster.plugins` (enables barman-cloud plugin / WAL archiver configuration).
- Redis Sentinel support for Sidekiq high availability:
  - New Helm template helpers (`permoney.redisSentinelEnabled`, `permoney.redisSentinelHosts`, `permoney.redisSentinelMaster`) for Sentinel configuration detection.
  - Automatic injection of `REDIS_SENTINEL_HOSTS` and `REDIS_SENTINEL_MASTER` environment variables when Sentinel mode is enabled.
  - Sidekiq configuration supports Sentinel authentication with `sentinel_username` (defaults to "default") and `sentinel_password`.
  - Robust validation of Sentinel endpoints with port range checking (1-65535) and graceful fallback to direct Redis URL on invalid configuration.
  - Backward compatible with existing `REDIS_URL` deployments.

## Notes
- Requires Kubernetes >= 1.25.0
- Prefer immutable image tags (avoid `latest`) for production stability
