# Grafana Setup Instructions - APM Monitoring Dashboard
**Date**: November 8, 2025  
**Purpose**: Unified visualization of Sentry APM + Prometheus metrics  

---

## Quick Start

### 1. Access Grafana
- **URL**: http://localhost:3000 (or your Grafana instance)
- **Default credentials**: admin/admin (if first setup)

### 2. Add Prometheus Data Source

1. Go to **Settings** (gear icon) → **Data Sources** → **Add data source**
2. Select **Prometheus**
3. Fill in:
   - **Name**: `Prometheus`
   - **URL**: `http://prometheus:9090` (Docker) or `http://localhost:9090`
   - **Scrape Interval**: Leave default
4. Click **Save & Test** - should show green "Data source is working"

### 3. Create Dashboard

**Option A: Import from JSON (Recommended)**
1. Go to **Dashboards** → **Create** → **Import**
2. Paste JSON below and click **Load**
3. Select **Prometheus** as data source
4. Click **Import**

**Option B: Create Manually**
1. Go to **Dashboards** → **Create** → **New dashboard**
2. Add panels using queries below

---

## Dashboard JSON Configuration

```json
{
  "dashboard": {
    "title": "Permoney Production - APM Overview",
    "timezone": "browser",
    "refresh": "30s",
    "panels": [
      {
        "id": 1,
        "title": "Request Latency (P95)",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(rails_request_duration_seconds_bucket[5m]))",
            "refId": "A",
            "legendFormat": "P95"
          }
        ],
        "yaxes": [
          {"label": "Seconds", "format": "s"}
        ]
      },
      {
        "id": 2,
        "title": "Error Rate",
        "type": "stat",
        "targets": [
          {
            "expr": "rate(rails_errors_total[5m])",
            "refId": "A"
          }
        ],
        "unit": "ops"
      },
      {
        "id": 3,
        "title": "HTTP Requests per Second",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(rails_requests_total[1m])",
            "refId": "A",
            "legendFormat": "{{method}} {{status}}"
          }
        ]
      },
      {
        "id": 4,
        "title": "Slow Requests (>1s)",
        "type": "stat",
        "targets": [
          {
            "expr": "rate(rails_slow_requests_total[5m])",
            "refId": "A"
          }
        ]
      },
      {
        "id": 5,
        "title": "Database Pool Utilization",
        "type": "gauge",
        "targets": [
          {
            "expr": "db_pool_connections{state='used'} / db_pool_connections{state='used'} + db_pool_connections{state='available'}",
            "refId": "A"
          }
        ],
        "unit": "percentunit"
      },
      {
        "id": 6,
        "title": "Active Connections",
        "type": "stat",
        "targets": [
          {
            "expr": "db_pool_connections{state='used'}",
            "refId": "A"
          }
        ]
      },
      {
        "id": 7,
        "title": "Request Duration by Endpoint",
        "type": "table",
        "targets": [
          {
            "expr": "topk(10, sum by (controller, action) (rate(rails_request_duration_seconds_sum[5m])))",
            "refId": "A"
          }
        ]
      },
      {
        "id": 8,
        "title": "Sidekiq Queue Depth",
        "type": "graph",
        "targets": [
          {
            "expr": "sidekiq_queue_size",
            "refId": "A",
            "legendFormat": "{{queue}}"
          }
        ]
      }
    ]
  }
}
```

---

## Key Metrics to Monitor

| Metric | Query | Alert Threshold |
|--------|-------|-----------------|
| P95 Latency | `histogram_quantile(0.95, rails_request_duration_seconds)` | > 1.0s |
| Error Rate | `rate(rails_errors_total[5m])` | > 0.01 (1%) |
| Slow Requests | `rate(rails_slow_requests_total[5m])` | > 0.1 (10/min) |
| DB Pool Saturation | `db_pool_connections{state='used'} / 40 * 100` | > 80% |
| Sidekiq Queue Depth | `sidekiq_queue_size` | > 1000 |

---

## Setting Up Alerts

1. Go to **Alerting** → **Alert Rules** → **New Alert Rule**
2. Create alerts for:
   - High error rate (> 1% per 5 min)
   - High latency (P95 > 1 second)
   - DB pool saturation (> 80%)
   - Slow request spike (> 10/min)

---

## Integration with Sentry

**To view Sentry traces in Grafana:**

1. Open Sentry issue
2. Copy transaction ID
3. Go to Grafana → Add panel
4. Use query to correlate with Prometheus metrics
5. Example: `rails_request_duration_seconds{transaction_id="..."}`

---

## Troubleshooting

### Metrics not showing?
1. Verify Prometheus is scraping: Go to Prometheus (port 9090) → Targets
2. Check metrics endpoint: `curl http://localhost:9394/metrics`
3. Verify Rails middleware is loaded

### Data source connection error?
1. Check Prometheus is running: `docker-compose ps`
2. Verify URL is correct for your environment
3. Check network connectivity between Grafana and Prometheus

### Dashboard looks empty?
1. Wait 30s for metrics to be collected
2. Make a request to trigger metrics: `curl http://localhost:3000/`
3. Verify data source is selected for each panel

---

## Next Steps

1. ✅ Verify Prometheus metrics available on :9394
2. ⏳ Add Prometheus data source to Grafana
3. ⏳ Create dashboard from JSON
4. ⏳ Setup alerts
5. ⏳ Monitor for first 24 hours

**Status**: Ready for Grafana configuration!
