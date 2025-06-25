-- Migration 004: Add robots_index column for SEO control
-- This enables per-page control over search engine indexing
-- Default is FALSE (noindex) - popular pages will be promoted to indexed via cron job

ALTER TABLE detections ADD COLUMN robots_index BOOLEAN DEFAULT FALSE;

-- Add index for efficient querying by robots status
CREATE INDEX IF NOT EXISTS idx_detections_robots_index ON detections (robots_index);

-- Add composite index for querying indexed pages by popularity metrics
CREATE INDEX IF NOT EXISTS idx_detections_indexed_pages ON detections (robots_index, page_id, created_at); 