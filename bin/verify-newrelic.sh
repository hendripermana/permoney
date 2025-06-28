#!/bin/bash

# Script untuk memverifikasi konfigurasi New Relic
# Usage: ./bin/verify-newrelic.sh

echo "🔍 Verifying New Relic Configuration..."
echo "========================================="

# Check if newrelic.yml exists
if [ -f "newrelic.yml" ]; then
    echo "✅ newrelic.yml file found"
else
    echo "❌ newrelic.yml file not found"
    exit 1
fi

# Check environment variables
if [ -n "$NEW_RELIC_LICENSE_KEY" ]; then
    echo "✅ NEW_RELIC_LICENSE_KEY is set"
    # Show partial key for verification (last 8 characters)
    echo "   License key ends with: ...${NEW_RELIC_LICENSE_KEY: -8}"
else
    echo "❌ NEW_RELIC_LICENSE_KEY is not set"
fi

if [ -n "$NEW_RELIC_APP_NAME" ]; then
    echo "✅ NEW_RELIC_APP_NAME is set to: $NEW_RELIC_APP_NAME"
else
    echo "⚠️  NEW_RELIC_APP_NAME is not set (will use default)"
fi

# Check if newrelic gem is installed
if bundle list | grep -q "newrelic_rpm"; then
    echo "✅ newrelic_rpm gem is installed"
    bundle list | grep newrelic_rpm
else
    echo "❌ newrelic_rpm gem is not installed"
fi

# Check if initializer exists
if [ -f "config/initializers/newrelic.rb" ]; then
    echo "✅ New Relic initializer found"
else
    echo "⚠️  New Relic initializer not found (optional)"
fi

echo ""
echo "🚀 New Relic verification complete!"
echo ""
echo "To test New Relic in production:"
echo "1. Deploy your application"
echo "2. Generate some traffic"
echo "3. Check https://one.newrelic.com for data"
echo ""
echo "Useful commands:"
echo "  - Check logs: docker compose logs web | grep -i newrelic"
echo "  - Test configuration: bundle exec newrelic install --license_key=YOUR_KEY"
