#!/bin/bash

# Migration 002: Add deleted_at column for soft deletes
# This migration adds support for 410 Gone responses for deleted detection pages

echo "Running Migration 002: Add deleted_at column..."

# Check if we're in the correct directory
if [ ! -f "wrangler.jsonc" ]; then
    echo "Error: wrangler.jsonc not found. Please run this script from the apps/worker directory."
    exit 1
fi

# Apply the migration
echo "Adding deleted_at column to detections table..."
npx wrangler d1 execute DB --file=./migrations/002_add_deleted_at_column.sql

echo "Migration 002 completed successfully!"
echo "The detections table now supports soft deletes with the deleted_at column."
echo ""
echo "Usage:"
echo "- deleted_at = NULL: Active detection page (normal operation)"
echo "- deleted_at = timestamp: Soft-deleted page (returns 410 Gone)" 