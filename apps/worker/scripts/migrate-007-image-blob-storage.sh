#!/bin/bash
# Migration 007: Add image blob storage columns for API uploads
# This enables storing uploaded image blobs directly in D1 database

echo "🔄 Running Migration 007: Adding image blob storage columns..."

# Apply the migration to the production database (using binding name with env flag)
wrangler d1 execute DB --file=./migrations/007_add_image_blob_storage.sql --env production --remote

echo "✅ Migration 007 completed: Image blob storage columns added to production database"
echo "📝 Note: Existing records will have NULL values for image_data and image_content_type"
echo "🔧 New blob uploads via API will now store image data directly in D1" 