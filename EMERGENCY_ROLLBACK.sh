#!/bin/bash

# EMERGENCY ROLLBACK SCRIPT for Maybe → Permoney Migration
# This script will rollback the system to the previous Maybe Finance version
# Use this ONLY in case of critical issues with the Permoney migration

set -e

echo "🚨 EMERGENCY ROLLBACK INITIATED"
echo "This will rollback from Permoney to the previous Maybe Finance version"
echo "All data will be preserved, but the application will be reverted"
echo ""

# Confirm rollback
read -p "Are you sure you want to proceed with the rollback? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo "Rollback cancelled."
    exit 0
fi

echo "Starting emergency rollback..."

# Navigate to application directory
cd /home/ubuntu/permoney

# Stop current services
echo "Stopping current services..."
docker-compose down

# Remove Permoney image
echo "Removing Permoney image..."
docker rmi maybe-finance:permoney-latest

# Pull previous Maybe Finance image
echo "Pulling previous Maybe Finance image..."
docker pull maybe-finance:latest

# Update docker-compose.yml to use previous image
echo "Updating docker-compose.yml..."
sed -i 's/maybe-finance:permoney-latest/maybe-finance:latest/g' docker-compose.yml

# Start services with previous image
echo "Starting services with previous image..."
docker-compose up -d

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 30

# Verify services are running
echo "Verifying services..."
docker-compose ps

echo ""
echo "✅ Emergency rollback completed successfully!"
echo "Application is now running the previous Maybe Finance version"
echo "All data has been preserved"
echo ""
echo "To re-migrate to Permoney later, run the migration process again"
echo ""
