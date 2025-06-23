# Cloudflare D1 Database Setup Guide

This guide walks you through setting up the Cloudflare D1 database for the Truthscan Twitter Bot.

## 🔐 Step 1: Authenticate with Cloudflare

First, you need to authenticate Wrangler with your Cloudflare account:

```bash
# Authenticate via browser (recommended)
wrangler auth login

# Alternative: Use API token
# wrangler auth login --api-token YOUR_API_TOKEN
```

This will open your browser and prompt you to authorize Wrangler access to your Cloudflare account.

## 📊 Step 2: Create the D1 Database

Create the D1 database instance:

```bash
wrangler d1 create truthscan-db
```

**Expected Output:**
```
✅ Successfully created DB 'truthscan-db'!

Add the following to your wrangler.toml:
[[d1_databases]]
binding = "DB"
database_name = "truthscan-db"
database_id = "your-unique-database-id-here"
```

## ⚙️ Step 3: Update Configuration

Copy the `database_id` from the output above and update `wrangler.jsonc`:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "truthscan-db",
      "database_id": "REPLACE_WITH_YOUR_ACTUAL_DATABASE_ID"
    }
  ]
}
```

## 🗄️ Step 4: Apply Database Schema

Apply the schema to both local (for development) and remote (for production) databases:

```bash
# Apply schema to local database (for wrangler dev)
wrangler d1 execute truthscan-db --local --file=./schema.sql

# Apply schema to remote database (for deployment)
wrangler d1 execute truthscan-db --file=./schema.sql
```

## ✅ Step 5: Verify Setup

### Test Local Database
```bash
# Start local development server
wrangler dev

# In another terminal, test database connectivity
curl http://localhost:8787/api/test-db
```

### Test Remote Database
```bash
# Deploy worker to test remote database
wrangler deploy

# Test remote database endpoint
curl https://truthscan-twitter-bot.YOUR_SUBDOMAIN.workers.dev/api/test-db
```

## 🔍 Step 6: Verify Database Content

You can query the database directly to verify it's working:

```bash
# Query local database
wrangler d1 execute truthscan-db --local --command="SELECT * FROM detections;"

# Query remote database  
wrangler d1 execute truthscan-db --command="SELECT * FROM detections;"
```

## 📋 Database Schema Overview

The schema includes:

### `detections` table:
- `id` (TEXT, PRIMARY KEY) - Unique detection ID
- `tweet_id` (TEXT, NOT NULL) - Twitter tweet ID
- `timestamp` (INTEGER, NOT NULL) - Unix timestamp
- `image_url` (TEXT, NOT NULL) - URL of analyzed image
- `detection_score` (REAL) - AI confidence score (0.0-1.0)
- `twitter_handle` (TEXT, NOT NULL) - User's Twitter handle
- `response_tweet_id` (TEXT) - Bot's response tweet ID
- `processing_time_ms` (INTEGER) - Processing duration
- `api_provider` (TEXT) - AI detection service used

### `webhook_logs` table:
- For debugging webhook payloads and tracking errors

## 🚨 Troubleshooting

### Authentication Issues
```bash
# Check current auth status
wrangler auth whoami

# Re-authenticate if needed
wrangler auth logout
wrangler auth login
```

### Database Connection Issues
1. Verify `database_id` in `wrangler.jsonc` matches the one from creation
2. Ensure schema was applied successfully
3. Check logs: `wrangler tail` when testing endpoints

### Local vs Remote Database
- Local database: Used during `wrangler dev` (separate from production)
- Remote database: Used in deployed workers
- Both need schema applied separately

## 🎯 Next Steps

Once setup is complete:
1. Test database connectivity via `/api/test-db` endpoint
2. Verify the `/api/detections` endpoint returns data from D1
3. Ready to proceed to Task 5: AI Detection API Integration

---

**Note:** Keep your `database_id` secure and don't commit it to public repositories. Consider using environment variables for sensitive configuration in production deployments. 