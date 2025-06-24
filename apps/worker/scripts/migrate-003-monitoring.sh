#!/bin/bash

# Migration 003: Add monitoring tables for Task 12
# This script adds the logs, page_views, and system_metrics tables

echo "Running Migration 003: Add monitoring tables..."

# Path to the migration SQL file
MIGRATION_FILE="migrations/003_add_monitoring_tables.sql"

# Check if migration file exists
if [ ! -f "$MIGRATION_FILE" ]; then
    echo "Error: Migration file $MIGRATION_FILE not found!"
    exit 1
fi

echo "Applying monitoring tables migration to development database..."

# Apply migration using wrangler d1 execute
npx wrangler d1 execute truthscan-db --local --file="$MIGRATION_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Migration 003 applied successfully!"
    echo "📊 Added tables: logs, page_views, system_metrics"
    echo "🔍 Added indexes for performance optimization"
    echo ""
    echo "New monitoring endpoints are now available:"
    echo "  - GET /api/monitoring/dashboard"
    echo "  - GET /api/monitoring/logs" 
    echo "  - GET /api/monitoring/page-views"
    echo "  - GET /api/monitoring/metrics"
else
    echo "❌ Migration 003 failed!"
    exit 1
fi 