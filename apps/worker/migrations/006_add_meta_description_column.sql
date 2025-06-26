-- Migration 006: Add meta_description column for Groq-generated meta descriptions
-- This stores longer descriptions for use in HTML meta tags

-- Add meta_description column to detections table
ALTER TABLE detections ADD COLUMN meta_description TEXT;

-- Create index for meta_description for potential searching/filtering
CREATE INDEX IF NOT EXISTS idx_detections_meta_description ON detections (meta_description);

-- Update existing records to have NULL meta_description (will be populated by future detections)
-- No data update needed as new column defaults to NULL 