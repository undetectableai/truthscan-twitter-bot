-- Migration: Add page_id column to detections table
-- Version: 001
-- Description: Add page_id TEXT column for shareable detection page URLs
-- Date: 2025-06-24

-- Add page_id column to existing detections table
ALTER TABLE detections ADD COLUMN page_id TEXT;

-- Add index for efficient page_id lookups
CREATE INDEX IF NOT EXISTS idx_detections_page_id ON detections (page_id);

-- Verify the migration completed successfully by querying table info
-- This will confirm the page_id column exists
PRAGMA table_info(detections); 