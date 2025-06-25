#!/bin/bash

# Migration 004: Add robots_index column for SEO control
# This migration adds per-page control over search engine indexing

echo "Running Migration 004: Add robots_index column..."

# Check if we're in the correct directory
if [ ! -f "wrangler.jsonc" ]; then
    echo "Error: wrangler.jsonc not found. Please run this script from the apps/worker directory."
    exit 1
fi

# Apply the migration
echo "Adding robots_index column to detections table..."
npx wrangler d1 execute DB --file=./migrations/004_add_robots_index_column.sql

echo "Migration 004 completed successfully!"
echo "The detections table now supports per-page SEO indexing control."
echo ""
echo "Usage:"
echo "- robots_index = FALSE (default): Page set to noindex"
echo "- robots_index = TRUE: Page is indexable by search engines"
echo ""
echo "Future: Cron job will promote popular pages (by view count) to indexed status" 