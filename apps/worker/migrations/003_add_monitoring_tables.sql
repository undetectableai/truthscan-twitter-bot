-- Migration 003: Add monitoring tables for Task 12
-- Add structured logging, page view tracking, and system metrics tables

-- Logs table for error and event logging
CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    log_level TEXT NOT NULL CHECK (log_level IN ('error', 'warn', 'info', 'debug')),
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    user_agent TEXT,
    ip_address TEXT,
    url TEXT,
    page_id TEXT,
    processing_time_ms INTEGER
);

-- Page views table for traffic monitoring
CREATE TABLE IF NOT EXISTS page_views (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    referrer TEXT,
    view_duration_ms INTEGER,
    is_bot INTEGER NOT NULL DEFAULT 0,
    country TEXT
);

-- System metrics table for performance monitoring  
CREATE TABLE IF NOT EXISTS system_metrics (
    id TEXT PRIMARY KEY,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    metric_type TEXT NOT NULL CHECK (metric_type IN ('counter', 'gauge', 'histogram')),
    timestamp INTEGER NOT NULL,
    period TEXT,
    tags TEXT
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(log_level);
CREATE INDEX IF NOT EXISTS idx_logs_event_type ON logs(event_type);

CREATE INDEX IF NOT EXISTS idx_page_views_timestamp ON page_views(timestamp);
CREATE INDEX IF NOT EXISTS idx_page_views_page_id ON page_views(page_id);
CREATE INDEX IF NOT EXISTS idx_page_views_is_bot ON page_views(is_bot);

CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_system_metrics_name ON system_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_system_metrics_type ON system_metrics(metric_type); 