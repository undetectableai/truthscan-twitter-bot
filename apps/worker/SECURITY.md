# Truthscan Twitter Bot - Security Guide

This document covers the security implementation for the Truthscan Twitter Bot, including secrets management, API protection, and deployment best practices.

## 🔐 Overview

The security implementation includes:
- **Secrets Management**: All sensitive credentials stored as Cloudflare Wrangler secrets
- **API Protection**: Optional Basic Authentication for dashboard API endpoints  
- **Secure Defaults**: No hardcoded secrets, environment-based configuration
- **Access Control**: Webhook endpoints remain public (as required by Twitter), API endpoints protected

## 📋 Required Secrets

### Twitter API Credentials (Required)
These are needed for the bot to interact with Twitter's API:

| Secret Name | Description | How to Get |
|-------------|-------------|-------------|
| `TWITTER_API_KEY` | Consumer Key | [Twitter Developer Portal](https://developer.twitter.com/en/apps) |
| `TWITTER_API_KEY_SECRET` | Consumer Secret | Twitter Developer Portal |
| `TWITTER_BEARER_TOKEN` | Bearer Token | Twitter Developer Portal |
| `TWITTER_ACCESS_TOKEN` | Access Token | Twitter Developer Portal |
| `TWITTER_ACCESS_TOKEN_SECRET` | Access Token Secret | Twitter Developer Portal |

### AI Detection API (Required)
For image analysis functionality:

| Secret Name | Description | How to Get |
|-------------|-------------|-------------|
| `AI_DETECTION_API_KEY` | Undetectable.AI API Key | [Undetectable.AI](https://ai-image-detect.undetectable.ai) |

### Dashboard Protection (Optional)
For protecting API endpoints with Basic Authentication:

| Secret Name | Description | Usage |
|-------------|-------------|-------|
| `BASIC_AUTH_USERNAME` | API access username | Optional, protects `/api/*` endpoints |
| `BASIC_AUTH_PASSWORD` | API access password | Optional, works with username above |

## 🚀 Quick Setup

### Automated Setup (Recommended)
Use our interactive script to configure all secrets:

```bash
cd apps/worker
chmod +x scripts/setup-secrets.sh
./scripts/setup-secrets.sh
```

### Manual Setup
Set individual secrets using Wrangler CLI:

```bash
# Twitter API credentials
wrangler secret put TWITTER_API_KEY
wrangler secret put TWITTER_API_KEY_SECRET
wrangler secret put TWITTER_BEARER_TOKEN
wrangler secret put TWITTER_ACCESS_TOKEN
wrangler secret put TWITTER_ACCESS_TOKEN_SECRET

# AI Detection API
wrangler secret put AI_DETECTION_API_KEY

# Optional: Dashboard protection
wrangler secret put BASIC_AUTH_USERNAME
wrangler secret put BASIC_AUTH_PASSWORD
```

## 🛡️ API Protection Details

### How It Works
- **Webhook endpoints** (`/webhook/*`) remain **unprotected** (required by Twitter)
- **API endpoints** (`/api/*`) are **protected with Basic Auth** (if credentials configured)
- If `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` are not set, API endpoints are **unprotected**

### Protected Endpoints
When Basic Auth is configured, these endpoints require authentication:
- `GET /api/detections` - Dashboard API for fetching detection data
- `GET /api/test-db` - Database connection testing

### Unprotected Endpoints
These endpoints remain public for Twitter integration:
- `GET /webhook/twitter` - Twitter CRC challenge validation
- `POST /webhook/twitter` - Twitter webhook events

### Testing Authentication
```bash
# Test without authentication (should fail if configured)
curl http://localhost:8787/api/detections

# Test with authentication (replace credentials)
curl -u "username:password" http://localhost:8787/api/detections
```

## 📱 Dashboard Integration

### Environment Variables
For the React dashboard to authenticate with protected APIs, set these environment variables:

```bash
# Create .env.local in apps/dashboard/
VITE_BASIC_AUTH_USERNAME=your_username
VITE_BASIC_AUTH_PASSWORD=your_password
```

### Production Deployment
For production deployments (e.g., Vercel, Cloudflare Pages):
1. Set environment variables in your deployment platform
2. Ensure variables are prefixed with `VITE_` for Vite builds
3. Use the production worker URL in dashboard configuration

## 🔒 Security Best Practices

### Development
- ✅ Never commit secrets to version control
- ✅ Use `.env` files for local development (gitignored)
- ✅ Rotate API keys regularly
- ✅ Use strong, unique passwords for Basic Auth

### Production
- ✅ Use Cloudflare Wrangler secrets for all sensitive data
- ✅ Enable Cloudflare Access for additional dashboard protection
- ✅ Monitor API usage and set up alerts
- ✅ Regularly audit access logs

### Network Security
- ✅ Use HTTPS for all production endpoints
- ✅ Implement CORS policies as needed
- ✅ Monitor for unusual API access patterns
- ✅ Consider IP allowlisting for sensitive operations

## 🚨 Emergency Procedures

### Compromised API Keys
1. **Immediately revoke** the compromised keys in their respective platforms
2. **Generate new keys** with the same permissions
3. **Update secrets** using `wrangler secret put KEY_NAME`
4. **Redeploy** the worker with `wrangler deploy`
5. **Test functionality** to ensure everything works

### Unauthorized Access
1. **Check access logs** in Cloudflare dashboard
2. **Rotate Basic Auth credentials** if configured
3. **Review recent API activity** in the database
4. **Consider temporary IP blocking** if needed

## 📊 Monitoring & Auditing

### Cloudflare Analytics
- Monitor request volume to protected endpoints
- Track authentication failures
- Review geographic access patterns

### Application Logs
- Failed authentication attempts are logged
- Database operations are tracked
- API response times are monitored

### Database Auditing
```sql
-- Check recent detection activity
SELECT * FROM detections 
ORDER BY timestamp DESC 
LIMIT 50;

-- Monitor API usage patterns
SELECT DATE(timestamp/1000, 'unixepoch') as date, 
       COUNT(*) as detections 
FROM detections 
GROUP BY date 
ORDER BY date DESC;
```

## 🔧 Troubleshooting

### Common Issues

**"Authentication required" errors**
- Verify `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` are set correctly
- Check dashboard environment variables are prefixed with `VITE_`
- Ensure credentials match between worker and dashboard

**"Invalid credentials" errors**
- Double-check username/password values
- Verify no extra spaces or special characters
- Test with curl to isolate dashboard vs API issues

**Worker deployment failures**
- Confirm all required secrets are set with `wrangler secret list`
- Check for typos in secret names
- Verify Wrangler authentication with `wrangler whoami`

### Debug Commands
```bash
# List all configured secrets
wrangler secret list

# Test local development
wrangler dev

# Deploy to production
wrangler deploy

# View logs
wrangler tail
```

## 📚 Additional Resources

- [Cloudflare Workers Security](https://developers.cloudflare.com/workers/platform/security/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)
- [Twitter API Security](https://developer.twitter.com/en/docs/authentication/oauth-1-0a)
- [Basic Authentication RFC](https://tools.ietf.org/html/rfc7617) 