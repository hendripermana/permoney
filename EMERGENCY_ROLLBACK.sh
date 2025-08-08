#!/bin/bash

# EMERGENCY ROLLBACK SCRIPT for Maybe → Sure Migration
# Created: $(date)
# Use this script ONLY if the migration fails and you need to restore the previous state

set -e

BACKUP_TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "🚨 EMERGENCY ROLLBACK INITIATED"
echo "Timestamp: $BACKUP_TIMESTAMP"

# Stop current services
echo "=== STOPPING CURRENT SERVICES ==="
docker-compose down

# Restore git state
echo "=== RESTORING GIT STATE ==="
cd /home/ubuntu/maybe
git checkout backup-pre-migration-20250808-110745 2>/dev/null || {
    echo "⚠️  Backup branch not found, checking stash..."
    git stash list | grep "Pre-migration stash" && {
        git stash pop $(git stash list | grep "Pre-migration stash" | head -1 | cut -d: -f1)
    }
}

# Restore environment files if needed
echo "=== CHECKING ENVIRONMENT FILES ==="
if [ -d "/tmp/env-backup-20250808-110654" ]; then
    echo "Environment backup found, ready to restore if needed"
    ls -la /tmp/env-backup-20250808-110654/
else
    echo "⚠️  No environment backup found"
fi

# Remove new Docker images
echo "=== CLEANING UP NEW IMAGES ==="
docker images | grep "sure-latest" && {
    docker rmi maybe-finance:sure-latest
    echo "Removed Sure images"
}

# Restart with old configuration
echo "=== RESTARTING ORIGINAL SERVICES ==="
docker-compose up -d

# Verify services
echo "=== VERIFYING ROLLBACK ==="
sleep 10
docker ps
curl -f http://localhost:3000 &>/dev/null && {
    echo "✅ Service rollback successful!"
} || {
    echo "❌ Service check failed, manual intervention required"
}

echo "🔄 ROLLBACK COMPLETED"
echo ""
echo "MANUAL STEPS IF NEEDED:"
echo "1. Check git status: git status"
echo "2. Check environment: ls -la .env*"
echo "3. Check services: docker ps"
echo "4. Check logs: docker-compose logs"
echo "5. Restore data if needed:"
echo "   - PostgreSQL: /tmp/postgres-backup-20250808-110624.tar.gz"
echo "   - Redis: /tmp/redis-backup-20250808-110637.tar.gz"
echo "   - App Storage: /tmp/app-storage-backup-20250808-110644.tar.gz"
