# Truthscan Twitter Bot - Cloudflare Worker

This Cloudflare Worker handles Twitter webhooks for the Truthscan bot, including CRC validation and processing tweet mentions for AI image detection.

## 🚀 Quick Start

1. **Install dependencies**: `npm install`
2. **Configure secrets**: `./scripts/setup-secrets.sh` (or see [SECURITY.md](./SECURITY.md))
3. **Set up D1 database**: Follow [D1_SETUP.md](./D1_SETUP.md)
4. **Start development**: `npm run dev`

## 🔐 Security Configuration

**⚠️ Important**: This application requires several API keys and secrets to function.

For complete security setup including:
- Twitter API credentials
- AI Detection API keys  
- Optional dashboard protection
- Best practices and troubleshooting

**See [SECURITY.md](./SECURITY.md) for detailed instructions.**

## 📊 Features

- **Twitter Webhook Handler**: Responds to Twitter CRC challenges and processes incoming tweet events
- **AI Image Detection**: Integrates with Undetectable.AI for real-time image analysis of photos and video thumbnails
- **Video Thumbnail Support**: Automatically extracts and analyzes thumbnails from Twitter videos and animated GIFs
- **Database Storage**: Stores detection results in Cloudflare D1 for dashboard analytics
- **Automated Replies**: Posts AI detection results back to Twitter automatically
- **Dashboard API**: Provides data endpoints for the React dashboard (optionally protected)
- **Security**: Comprehensive secrets management and optional API protection

## 🛠️ Development

### Environment Variables (in wrangler.jsonc)
- `ENVIRONMENT`: Set to "development" or "production"
- `TWITTER_BOT_USERNAME`: The Twitter handle of the bot account (without @), currently set to "truth_scan"

### Required Secrets (via Wrangler)
All sensitive credentials are stored as Cloudflare secrets. See [SECURITY.md](./SECURITY.md) for setup instructions.

### Development Commands
```bash
# Start local development server
npm run dev

# Deploy to production
npm run deploy

# View logs
npm run logs

# List configured secrets
wrangler secret list
```

## 📡 API Endpoints

### Public Endpoints (Twitter Integration)
- `GET /webhook/twitter` - Twitter CRC challenge validation
- `POST /webhook/twitter` - Incoming webhook events from Twitter

### Protected Endpoints (Dashboard API)
- `GET /api/detections` - Fetch recent detection data
- `GET /api/test-db` - Test database connectivity

*Note: API endpoints are protected with Basic Auth if `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` secrets are configured.*

## 🏗️ Architecture

The worker processes Twitter mentions in real-time:

1. **Webhook Reception**: Receives tweet mentions via Twitter webhook
2. **Mention Detection**: Filters for tweets mentioning @truth_scan
3. **Image Extraction**: Extracts image URLs from tweet media
4. **AI Analysis**: Sends images to Undetectable.AI for analysis
5. **Database Storage**: Stores results in D1 for analytics
6. **Automated Reply**: Posts detection results back to Twitter
7. **Dashboard API**: Serves data to React dashboard

## 🔄 Data Flow

```
Twitter → Webhook → Worker → AI API → Database → Dashboard
                      ↓
                Twitter Reply
```

## 📈 Monitoring

- View real-time logs: `wrangler tail`
- Monitor in Cloudflare dashboard: Analytics section
- Database queries: Use D1 console or dashboard API
- Security events: Check worker logs for auth failures

## 🐛 Troubleshooting

### Common Issues

**Webhook not receiving events**
- Verify Twitter app webhook URL configuration
- Check CRC challenge validation is working
- Ensure all Twitter API secrets are correctly set

**AI detection not working**
- Verify `AI_DETECTION_API_KEY` is set correctly
- Check API quota/rate limits
- Review worker logs for API errors

**Database errors**
- Ensure D1 database is created and bound correctly
- Check schema is applied: `wrangler d1 execute truthscan-db --file=./schema.sql`
- Verify database ID in wrangler.jsonc matches created database

For complete troubleshooting guides, see [SECURITY.md](./SECURITY.md) and [D1_SETUP.md](./D1_SETUP.md).

## 📚 Additional Documentation

- [SECURITY.md](./SECURITY.md) - Comprehensive security setup and best practices
- [D1_SETUP.md](./D1_SETUP.md) - Database configuration instructions
- [schema.sql](./schema.sql) - Database schema definition