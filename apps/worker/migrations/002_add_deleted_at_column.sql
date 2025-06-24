-- Migration 002: Add deleted_at column for soft deletes
-- This enables 410 Gone responses for permanently deleted detection pages

ALTER TABLE detections ADD COLUMN deleted_at INTEGER DEFAULT NULL;

-- Add index for efficient querying of non-deleted records
CREATE INDEX IF NOT EXISTS idx_detections_deleted_at ON detections (deleted_at);

-- Add index for active (non-deleted) page_id lookups
CREATE INDEX IF NOT EXISTS idx_detections_active_page_id ON detections (page_id, deleted_at); 