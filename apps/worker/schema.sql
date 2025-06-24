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
    page_id TEXT,                     -- Short URL identifier for shareable detection page (e.g., 'abc123')
    created_at INTEGER DEFAULT (strftime('%s', 'now')), -- Created timestamp
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))  -- Updated timestamp
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_detections_tweet_id ON detections (tweet_id);
CREATE INDEX IF NOT EXISTS idx_detections_twitter_handle ON detections (twitter_handle);
CREATE INDEX IF NOT EXISTS idx_detections_timestamp ON detections (timestamp);
CREATE INDEX IF NOT EXISTS idx_detections_score ON detections (detection_score);
CREATE INDEX IF NOT EXISTS idx_detections_created_at ON detections (created_at);
CREATE INDEX IF NOT EXISTS idx_detections_page_id ON detections (page_id);

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

-- MONITORING TABLES --

-- Table for structured error and event logging
CREATE TABLE IF NOT EXISTS error_logs (
    id TEXT PRIMARY KEY,                    -- Unique log ID
    timestamp INTEGER NOT NULL,             -- Unix timestamp
    log_level TEXT NOT NULL,                -- 'error', 'warn', 'info', 'debug'
    event_type TEXT NOT NULL,               -- 'page_not_found', 'database_error', 'image_load_failed', 'api_error', etc.
    message TEXT NOT NULL,                  -- Human-readable error message
    details TEXT,                           -- JSON string with additional details
    user_agent TEXT,                        -- User agent string
    ip_address TEXT,                        -- Client IP address
    url TEXT,                               -- Request URL that caused the error
    page_id TEXT,                           -- Related page_id (if applicable)
    processing_time_ms INTEGER,             -- Time taken for the operation that failed
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Indexes for error logs
CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs (timestamp);
CREATE INDEX IF NOT EXISTS idx_error_logs_level ON error_logs (log_level);
CREATE INDEX IF NOT EXISTS idx_error_logs_event_type ON error_logs (event_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_page_id ON error_logs (page_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs (created_at);

-- Table for page view tracking and basic statistics
CREATE TABLE IF NOT EXISTS page_views (
    id TEXT PRIMARY KEY,                    -- Unique view ID
    page_id TEXT NOT NULL,                  -- The page_id that was viewed
    timestamp INTEGER NOT NULL,             -- Unix timestamp of the view
    user_agent TEXT,                        -- User agent string
    ip_address TEXT,                        -- Client IP address
    referrer TEXT,                          -- HTTP referrer header
    view_duration_ms INTEGER,               -- Time spent on page (if measurable)
    is_bot BOOLEAN DEFAULT FALSE,           -- Whether this appears to be a bot request
    country TEXT,                           -- Country code (if available from CF headers)
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Indexes for page views
CREATE INDEX IF NOT EXISTS idx_page_views_page_id ON page_views (page_id);
CREATE INDEX IF NOT EXISTS idx_page_views_timestamp ON page_views (timestamp);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views (created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_is_bot ON page_views (is_bot);

-- Table for basic system metrics and statistics
CREATE TABLE IF NOT EXISTS system_metrics (
    id TEXT PRIMARY KEY,                    -- Unique metric ID
    metric_name TEXT NOT NULL,              -- Name of the metric (e.g., 'daily_detections', 'error_rate')
    metric_value REAL NOT NULL,             -- Numeric value of the metric
    metric_type TEXT NOT NULL,              -- Type: 'counter', 'gauge', 'histogram'
    timestamp INTEGER NOT NULL,             -- Unix timestamp when metric was recorded
    period TEXT,                            -- Time period for the metric ('hour', 'day', 'week')
    tags TEXT,                              -- JSON string with metric tags/labels
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Indexes for system metrics
CREATE INDEX IF NOT EXISTS idx_system_metrics_name ON system_metrics (metric_name);
CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics (timestamp);
CREATE INDEX IF NOT EXISTS idx_system_metrics_type ON system_metrics (metric_type);
CREATE INDEX IF NOT EXISTS idx_system_metrics_period ON system_metrics (period);

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