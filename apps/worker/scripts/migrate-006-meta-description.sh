#!/bin/bash

# Migration 006: Add meta_description column to detections table
# This migration adds support for storing meta descriptions for HTML meta tags

set -e

echo "🚀 Running Migration 006: Add meta_description column..."

# Check if we're in the correct directory
if [ ! -f "wrangler.jsonc" ]; then
    echo "❌ Error: Please run this script from the apps/worker directory"
    exit 1
fi

# Run the migration
echo "📝 Adding meta_description column to detections table..."
npx wrangler d1 execute truthscan-db --file=./migrations/006_add_meta_description_column.sql

echo "✅ Migration 006 completed successfully!"
echo "📊 The detections table now includes a meta_description column for storing Groq-generated meta descriptions."
echo ""
echo "🔧 Next steps:"
echo "   1. Deploy the updated worker code with meta description functionality"
echo "   2. Test with a new image detection to verify meta description generation"
echo "   3. Check HTML meta tags in browser developer tools" 