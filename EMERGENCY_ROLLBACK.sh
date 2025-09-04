#!/bin/bash

# EMERGENCY ROLLBACK SCRIPT for Application Migration
# This script will rollback the system to the previous version
# Use this ONLY in case of critical issues with the current deployment

set -e

# Load configuration from environment or use defaults
APP_NAME=${APP_NAME:-"Permoney"}
DEPLOYMENT_PATH=${DEPLOYMENT_PATH:-"/home/ubuntu/permoney"}
DOCKER_IMAGE_NAME=${DOCKER_IMAGE_NAME:-"ghcr.io/hendripermana/permoney"}
DOCKER_IMAGE_TAG=${DOCKER_IMAGE_TAG:-"latest"}
PREVIOUS_IMAGE=${PREVIOUS_IMAGE:-"maybe-finance:latest"}
COMPOSE_FILE=${COMPOSE_FILE:-"docker-compose.yml"}

echo "🚨 EMERGENCY ROLLBACK INITIATED"
echo "This will rollback from $APP_NAME to the previous version"
echo "All data will be preserved, but the application will be reverted"
echo "Deployment path: $DEPLOYMENT_PATH"
echo "Current image: $DOCKER_IMAGE_NAME:$DOCKER_IMAGE_TAG"
echo "Rollback image: $PREVIOUS_IMAGE"
echo ""

# Confirm rollback
read -p "Are you sure you want to proceed with the rollback? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo "Rollback cancelled."
    exit 0
fi

echo "Starting emergency rollback..."

# Navigate to application directory
if [ ! -d "$DEPLOYMENT_PATH" ]; then
    echo "❌ Error: Deployment path $DEPLOYMENT_PATH does not exist"
    exit 1
fi

cd "$DEPLOYMENT_PATH"

# Stop current services
echo "Stopping current services..."
docker-compose -f "$COMPOSE_FILE" down

# Remove current image (if it exists)
echo "Removing current image..."
if docker images | grep -q "$DOCKER_IMAGE_NAME:$DOCKER_IMAGE_TAG"; then
    docker rmi "$DOCKER_IMAGE_NAME:$DOCKER_IMAGE_TAG" || echo "Warning: Could not remove current image"
fi

# Pull previous image
echo "Pulling previous image..."
if ! docker pull "$PREVIOUS_IMAGE"; then
    echo "❌ Error: Could not pull previous image $PREVIOUS_IMAGE"
    echo "Please check if the image exists and is accessible"
    exit 1
fi

# Update compose file to use previous image
echo "Updating $COMPOSE_FILE..."
if [ -f "$COMPOSE_FILE" ]; then
    # Create backup of compose file
    cp "$COMPOSE_FILE" "$COMPOSE_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    
    # Update image references
    # Update image references only on image lines
    sed -i.bak -E "s|^([[:space:]]*image:[[:space:]]*)$DOCKER_IMAGE_NAME:$DOCKER_IMAGE_TAG$|\1$PREVIOUS_IMAGE|g" "$COMPOSE_FILE"
    echo "Updated image references in $COMPOSE_FILE"
else
    echo "❌ Error: $COMPOSE_FILE not found"
    exit 1
fi

# Start services with previous image
echo "Starting services with previous image..."
docker-compose -f "$COMPOSE_FILE" up -d

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 30

# Verify services are running
echo "Verifying services..."
docker-compose -f "$COMPOSE_FILE" ps

echo ""
echo "✅ Emergency rollback completed successfully!"
echo "Application is now running the previous version: $PREVIOUS_IMAGE"
echo "All data has been preserved"
echo "Compose file backup created with timestamp"
echo ""
echo "To re-deploy $APP_NAME later, run the deployment process again"
echo ""
