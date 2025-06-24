#!/bin/bash

# Truthscan Twitter Bot - Database Migration Script
# Migration 001: Add page_id column to detections table
# 
# This script applies the page_id column migration to both local and remote D1 databases
# Usage: ./scripts/migrate-001-page-id.sh [local|remote|both]

set -e  # Exit on any error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default to both if no argument provided
TARGET="${1:-both}"

echo "🔄 Starting Migration 001: Add page_id column"
echo "📊 Database: truthscan-db"
echo "🎯 Target: $TARGET"
echo ""

# Function to run migration on local database
migrate_local() {
    echo -e "${YELLOW}📍 Applying migration to LOCAL database...${NC}"
    
    if wrangler d1 execute truthscan-db --local --file=./migrations/001_add_page_id_column.sql; then
        echo -e "${GREEN}✅ Local migration completed successfully${NC}"
        
        # Verify by checking table structure
        echo "🔍 Verifying local migration..."
        wrangler d1 execute truthscan-db --local --command="PRAGMA table_info(detections);"
    else
        echo -e "${RED}❌ Local migration failed${NC}"
        return 1
    fi
}

# Function to run migration on remote database
migrate_remote() {
    echo -e "${YELLOW}🌐 Applying migration to REMOTE database...${NC}"
    
    if wrangler d1 execute truthscan-db --file=./migrations/001_add_page_id_column.sql; then
        echo -e "${GREEN}✅ Remote migration completed successfully${NC}"
        
        # Verify by checking table structure
        echo "🔍 Verifying remote migration..."
        wrangler d1 execute truthscan-db --command="PRAGMA table_info(detections);"
    else
        echo -e "${RED}❌ Remote migration failed${NC}"
        return 1
    fi
}

# Change to worker directory to ensure relative paths work
cd "$(dirname "$0")/.."

# Check if migration file exists
if [ ! -f "./migrations/001_add_page_id_column.sql" ]; then
    echo -e "${RED}❌ Migration file not found: ./migrations/001_add_page_id_column.sql${NC}"
    exit 1
fi

# Execute migration based on target
case $TARGET in
    "local")
        migrate_local
        ;;
    "remote")
        migrate_remote
        ;;
    "both")
        migrate_local
        echo ""
        migrate_remote
        ;;
    *)
        echo -e "${RED}❌ Invalid target: $TARGET${NC}"
        echo "Usage: $0 [local|remote|both]"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}🎉 Migration 001 completed successfully!${NC}"
echo ""
echo "📋 Summary:"
echo "  • Added page_id TEXT column to detections table"
echo "  • Added idx_detections_page_id index for performance" 
echo "  • Existing data preserved and unchanged"
echo ""
echo "🚀 Ready for detection page URL generation (Task 2)" 