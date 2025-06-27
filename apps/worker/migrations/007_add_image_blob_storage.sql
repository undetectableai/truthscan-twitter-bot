-- Migration 007: Add image blob storage columns for API uploads
-- This enables storing uploaded image blobs directly in D1 database

-- Add image_data column to store blob data as BLOB type
ALTER TABLE detections ADD COLUMN image_data BLOB;

-- Add image_content_type column to store the MIME type (e.g., 'image/png', 'image/jpeg')
ALTER TABLE detections ADD COLUMN image_content_type TEXT;

-- Create index for image_content_type for potential filtering by image type
CREATE INDEX IF NOT EXISTS idx_detections_image_content_type ON detections (image_content_type);

-- No data update needed as new columns default to NULL
-- Future blob uploads will populate these columns via the API 