-- Truthscan Twitter Bot - D1 Database Schema
-- This schema defines the structure for storing AI image detection results

-- Main table for storing detection results
CREATE TABLE IF NOT EXISTS detections (
    id TEXT PRIMARY KEY,              -- Unique ID for the detection record (UUID)
    tweet_id TEXT NOT NULL,           -- ID of the tweet containing the image
    timestamp INTEGER NOT NULL,       -- Unix timestamp of detection
    image_url TEXT NOT NULL,          -- URL of the analyzed image
    detection_score REAL,             -- AI probability (0.0 to 1.0, e.g., 0.84 for 84%)
    twitter_handle TEXT NOT NULL,     -- Handle of the user who authored the tweet
    response_tweet_id TEXT,           -- ID of our bot's response tweet (if any)
    processing_time_ms INTEGER,       -- Time taken to process the detection (in milliseconds)
    api_provider TEXT,                -- Which AI detection API was used
    created_at INTEGER DEFAULT (strftime('%s', 'now')), -- Created timestamp
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))  -- Updated timestamp
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_detections_tweet_id ON detections (tweet_id);
CREATE INDEX IF NOT EXISTS idx_detections_twitter_handle ON detections (twitter_handle);
CREATE INDEX IF NOT EXISTS idx_detections_timestamp ON detections (timestamp);
CREATE INDEX IF NOT EXISTS idx_detections_score ON detections (detection_score);
CREATE INDEX IF NOT EXISTS idx_detections_created_at ON detections (created_at);

-- Optional: Table for storing raw webhook payloads for debugging
CREATE TABLE IF NOT EXISTS webhook_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    payload TEXT NOT NULL,            -- JSON payload from Twitter
    processed BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_timestamp ON webhook_logs (timestamp);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_processed ON webhook_logs (processed);

-- Insert initial test data (for development)
INSERT OR IGNORE INTO detections (
    id, 
    tweet_id, 
    timestamp, 
    image_url, 
    detection_score, 
    twitter_handle,
    processing_time_ms,
    api_provider
) VALUES (
    'test-detection-1',
    '1234567890',
    strftime('%s', 'now'),
    'https://example.com/test-image.jpg',
    0.85,
    'test_user',
    250,
    'mock-api'
); 