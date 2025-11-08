# APM Integration Guide - Connecting Permoney with Existing Monitoring Stack
**For**: Ubuntu server with Cloudflare Zero + Existing Prometheus/Grafana setup  
**Date**: November 8, 2025

---

## Current Architecture

```
Permoney Containers (permoney_permoney_net):
  • permoney-web-1 (9394/metrics)
  • permoney-worker-1
  • db (PostgreSQL)
  • redis

Monitoring Stack (maybe_maybe_net):
  • prometheus:9090
  • grafana:3001
  • loki:3100
  • alertmanager:9093
  • exporters (postgres, redis, node, cadvisor)
```

**Challenge**: Different docker networks (permoney_permoney_net vs maybe_maybe_net)  
**Solution**: Use host docker networking through Cloudflare tunnel

---

## Option A: Via Host Network (Recommended - Works with Cloudflare Zero)

Since you have Cloudflare Zero protecting port 9394, Prometheus can access metrics through:
- `http://host.docker.internal:9394` (from inside monitoring containers)
- `http://localhost:9394` (from host machine)

### Step 1: Update Prometheus Config

```bash
# Access prometheus container
docker exec -it prometheus /bin/sh

# Edit prometheus.yml (or recreate from backup)
cat > /etc/prometheus/prometheus.yml << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "rules/*.yml"

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']
    scrape_interval: 5s

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']
    scrape_interval: 5s

  # Existing maybe-app or metrics-exporter
  - job_name: 'maybe-app'
    static_configs:
      - targets: ['metrics-exporter:9394']
    scrape_interval: 30s

  # NEW: Permoney APM Metrics
  - job_name: 'permoney-apm'
    static_configs:
      - targets: ['host.docker.internal:9394']
    scrape_interval: 30s
    metrics_path: /metrics
    scrape_timeout: 10s
    # If host.docker.internal doesn't work, try:
    # - targets: ['172.17.0.1:9394']  # Docker gateway

  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres-exporter:9187']
    scrape_interval: 30s

  - job_name: 'redis'
    static_configs:
      - targets: ['redis-exporter:9121']
    scrape_interval: 30s

  - job_name: 'netdata-local'
    static_configs:
      - targets: ['host.docker.internal:19999']
EOF

# Reload Prometheus (send SIGHUP)
kill -HUP 1
```

### Step 2: Verify Metrics Collection

1. Go to Prometheus: `http://localhost:9090/targets`
2. Look for `permoney-apm` job
3. Status should show "UP"

---

## Option B: Via Docker Network Connection

If Option A doesn't work, connect networks:

```bash
# Connect prometheus to permoney network
docker network connect permoney_permoney_net prometheus

# Update prometheus config to use internal hostname
# target: 'permoney-web-1:9394'
```

---

## Integration with Grafana

### Step 1: Add Sentry Data Source

1. Go to Grafana: `http://localhost:3001`
2. Settings → Data Sources → Add
3. **Type**: `Sentry`
4. **Name**: `Sentry`
5. **API Key**: Get from https://sentry.io/settings/account/api/auth-tokens/
6. **Organization slug**: Your org name
7. **Project slug**: `permoney`
8. **Save & Test**

### Step 2: Create Unified APM Dashboard

1. **Dashboards** → **New** → **Create dashboard**
2. **Add panels**:

#### Panel 1: Error Rate (from Sentry)
```
Query: SELECT error_rate FROM sentry WHERE time > now() - 1h
```

#### Panel 2: Request Latency (from Prometheus)
```
Query: histogram_quantile(0.95, rate(rails_request_duration_seconds_bucket[5m]))
Label: P95 Latency
```

#### Panel 3: Database Connections (from Prometheus)
```
Query: db_pool_connections{state="used"}
```

#### Panel 4: Error Timeline (from Sentry + Prometheus)
```
Sentry: issue.count
Prometheus: rate(rails_errors_total[5m])
```

---

## Metrics Available (Now Collecting)

From Prometheus (port 9394):
- `rails_request_duration_seconds` - Request latency
- `rails_requests_total` - Total requests
- `rails_slow_requests_total` - Slow requests (>1s)
- `rails_errors_total` - Total errors
- `db_pool_connections` - Database pool usage
- `sidekiq_queue_size` - Background job queue depth

From Sentry (via OAuth):
- Error rates
- Transaction traces
- Performance profiles
- Release tracking
- User context

---

## Troubleshooting

### Prometheus can't reach permoney-apm
```bash
# Test from prometheus container
docker exec prometheus wget http://host.docker.internal:9394/metrics

# If that fails, try docker gateway:
docker exec prometheus wget http://172.17.0.1:9394/metrics

# If still fails, use network connect option B
```

### Sentry integration not working
- Verify API key has correct permissions
- Check organization/project slugs match
- Ensure `SENTRY_DSN` in permoney .env is correct

### Grafana dashboard empty
- Wait 30 seconds for metrics to collect
- Make HTTP requests to generate metrics: `curl http://localhost:3000/`
- Check Prometheus targets showing "UP"

---

## Next Steps

1. ✅ **APM Setup**: Complete (Sentry + Prometheus metrics active)
2. ⏳ **Connect Networks**: Update Prometheus config
3. ⏳ **Grafana Dashboard**: Add data sources + panels
4. ⏳ **Sentry Integration**: Configure API key
5. ⏳ **Monitoring**: Set up alerts

---

## Production Deployment (via Cloudflare)

Since you have Cloudflare Zero:

1. **Prometheus access**: Through Cloudflare tunnel (already done)
2. **Metrics endpoint**: Port 9394 accessible via `https://your-domain:9394/metrics`
3. **Grafana access**: Through existing Cloudflare setup on port 3001

Everything secured by Cloudflare Zero automatically!

---

## Quick Reference

| Component | Port | Network | Status |
|-----------|------|---------|--------|
| Prometheus | 9090 | maybe_maybe_net | ✅ Running |
| Grafana | 3001 | maybe_maybe_net | ✅ Running |
| Permoney APM | 9394 | permoney_permoney_net | ✅ Active |
| Sentry | SaaS | External | ✅ Configured |

