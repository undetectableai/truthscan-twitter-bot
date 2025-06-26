#!/bin/bash

# Migration 005: Add image_description column to detections table
# This migration adds support for storing image descriptions extracted by Groq API

set -e

echo "🚀 Running Migration 005: Add image_description column..."

# Check if we're in the correct directory
if [ ! -f "wrangler.jsonc" ]; then
    echo "❌ Error: Please run this script from the apps/worker directory"
    exit 1
fi

# Run the migration
echo "📝 Adding image_description column to detections table..."
npx wrangler d1 execute truthscan-db --file=./migrations/005_add_image_description_column.sql

echo "✅ Migration 005 completed successfully!"
echo "📊 The detections table now includes an image_description column for storing Groq API analysis results."
echo ""
echo "🔧 Next steps:"
echo "   1. Ensure GROQ_API_KEY is configured in your environment variables"
echo "   2. Deploy the updated worker code"
echo "   3. Test with a new image detection to verify Groq API integration" 