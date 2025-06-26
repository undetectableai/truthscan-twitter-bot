-- Migration 005: Add image description column for Groq API image analysis
-- This adds support for storing short descriptions of images extracted by Groq API

ALTER TABLE detections ADD COLUMN image_description TEXT; 