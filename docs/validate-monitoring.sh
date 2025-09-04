#!/bin/bash

# ===================================================================
# COMPREHENSIVE MONITORING STACK VALIDATION SCRIPT
# ===================================================================
# This script validates the entire monitoring stack health
# ===================================================================

echo "🔍 COMPREHENSIVE MONITORING STACK VALIDATION"
echo "=============================================="

echo ""
echo "1. CONTAINER HEALTH CHECK:"
echo "--------------------------"
docker compose ps | grep -E "(prometheus|grafana|loki|promtail|alertmanager)"

echo ""
echo "2. PROMTAIL CONFIGURATION VALIDATION:"
echo "-------------------------------------"
docker run --rm -v /home/ubuntu/monitoring/configs/promtail.yml:/etc/promtail/config.yml \
  grafana/promtail:latest -config.file=/etc/promtail/config.yml -check-syntax

echo ""
echo "3. LOG INGESTION STATUS:"
echo "------------------------"
echo "Recent Promtail logs (last 5 minutes):"
docker compose logs promtail --since=5m --tail=10

echo ""
echo "4. LOKI HEALTH CHECK:"
echo "--------------------"
curl -s http://localhost:3100/ready || echo "❌ Loki not ready"
curl -s http://localhost:3100/metrics | grep -q "loki_ingester_streams" && echo "✅ Loki ingesting streams" || echo "❌ Loki ingestion issue"

echo ""
echo "5. PROMETHEUS TARGETS:"
echo "---------------------"
curl -s http://localhost:9090/api/v1/targets | jq -r '.data.activeTargets[].health' | sort | uniq -c

echo ""
echo "6. SYSTEM RESOURCES:"
echo "-------------------"
echo "Docker system usage:"
docker system df

echo ""
echo "Memory usage by monitoring containers:"
docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep -E "(prometheus|grafana|loki|promtail|alertmanager)"

echo ""
echo "7. LOG VOLUME STATISTICS:"
echo "------------------------"
echo "Container log sizes (top 10):"
du -sh /var/lib/docker/containers/*/  | sort -hr | head -10

echo ""
echo "✅ MONITORING VALIDATION COMPLETE"
echo "================================="
