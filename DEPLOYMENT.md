# Truthscan Twitter Bot - Deployment Guide

This guide covers the complete deployment process for the Truthscan Twitter Bot, including both the Cloudflare Worker and React dashboard to Cloudflare Pages.

## 🏗️ Architecture Overview

The project consists of two main components:
- **Worker** (`apps/worker/`) - Cloudflare Worker handling Twitter webhooks and AI detection
- **Dashboard** (`apps/dashboard/`) - React dashboard deployed to Cloudflare Pages

## 🚀 Quick Deployment

### Prerequisites
1. **Install dependencies**: `pnpm install:all`
2. **Authenticate with Cloudflare**: `wrangler auth login`
3. **Configure secrets**: `pnpm setup` (runs interactive setup)

### Deploy Everything
```bash
# Deploy to development (default)
pnpm deploy

# Deploy to staging
pnpm deploy:staging

# Deploy to production  
pnpm deploy:prod
```

## 📋 Detailed Setup

### 1. Environment Setup

The project supports three environments:
- **Development** (default) - For local testing and development
- **Staging** - For testing before production
- **Production** - Live production environment

### 2. Worker Configuration

The worker uses environment-specific configurations in `apps/worker/wrangler.jsonc`:

| Environment | Worker Name | Database |
|-------------|-------------|----------|
| Development | `truthscan-twitter-bot` | `truthscan-db` |
| Staging | `truthscan-twitter-bot-staging` | `truthscan-db-staging` |
| Production | `truthscan-twitter-bot-prod` | `truthscan-db-prod` |

### 3. Database Setup

#### Development Database
```bash
cd apps/worker
wrangler d1 create truthscan-db
# Update database_id in wrangler.jsonc
wrangler d1 execute truthscan-db --file=./schema.sql
```

#### Staging Database
```bash
wrangler d1 create truthscan-db-staging
# Update staging database_id in wrangler.jsonc  
wrangler d1 execute truthscan-db-staging --file=./schema.sql
```

#### Production Database
```bash
wrangler d1 create truthscan-db-prod
# Update production database_id in wrangler.jsonc
wrangler d1 execute truthscan-db-prod --file=./schema.sql
```

### 4. Secrets Configuration

#### For Development
```bash
cd apps/worker
./scripts/setup-secrets.sh
```

#### For Staging
```bash
wrangler secret put TWITTER_API_KEY --env staging
wrangler secret put TWITTER_API_KEY_SECRET --env staging
wrangler secret put TWITTER_BEARER_TOKEN --env staging
wrangler secret put TWITTER_ACCESS_TOKEN --env staging
wrangler secret put TWITTER_ACCESS_TOKEN_SECRET --env staging
wrangler secret put AI_DETECTION_API_KEY --env staging
# Optional:
wrangler secret put BASIC_AUTH_USERNAME --env staging
wrangler secret put BASIC_AUTH_PASSWORD --env staging
```

#### For Production
```bash
wrangler secret put TWITTER_API_KEY --env production
wrangler secret put TWITTER_API_KEY_SECRET --env production
wrangler secret put TWITTER_BEARER_TOKEN --env production
wrangler secret put TWITTER_ACCESS_TOKEN --env production
wrangler secret put TWITTER_ACCESS_TOKEN_SECRET --env production
wrangler secret put AI_DETECTION_API_KEY --env production
# Optional:
wrangler secret put BASIC_AUTH_USERNAME --env production
wrangler secret put BASIC_AUTH_PASSWORD --env production
```

## 🔧 Available Scripts

### Root Level Commands

#### Development
```bash
pnpm dev                    # Start both worker and dashboard in dev mode
pnpm build                  # Build both applications
pnpm build:check           # Build and validate TypeScript
pnpm lint                   # Lint all code
pnpm test:build            # Test that everything builds successfully
```

#### Deployment
```bash
pnpm deploy                 # Deploy both to development
pnpm deploy:staging        # Deploy both to staging
pnpm deploy:prod           # Deploy both to production
```

#### Database Management
```bash
pnpm db:setup              # Create and migrate development database
pnpm db:migrate            # Migrate existing database
pnpm db:migrate:local      # Migrate local database
```

#### Pages Management
```bash
pnpm pages:create          # Create all Pages projects
pnpm pages:list           # List existing Pages projects
```

### Worker-Specific Commands

```bash
pnpm worker:dev            # Start worker in development mode
pnpm worker:deploy         # Deploy worker to development
pnpm worker:deploy:staging # Deploy worker to staging
pnpm worker:deploy:prod    # Deploy worker to production
pnpm worker:logs           # View worker logs
pnpm worker:status         # Check worker status and secrets
```

### Dashboard-Specific Commands

```bash
pnpm dashboard:dev         # Start dashboard development server
pnpm dashboard:build       # Build dashboard
pnpm dashboard:deploy      # Deploy dashboard to development
pnpm dashboard:deploy:staging  # Deploy dashboard to staging
pnpm dashboard:deploy:prod     # Deploy dashboard to production
pnpm dashboard:preview     # Preview built dashboard locally
```

## 🌐 Pages Setup

### Create Pages Projects

First-time setup requires creating Pages projects:

```bash
# Create all Pages projects at once
pnpm pages:create

# Or create individually
cd apps/dashboard
wrangler pages project create truthscan-dashboard
wrangler pages project create truthscan-dashboard-staging  
wrangler pages project create truthscan-dashboard-prod
```

### Dashboard Environment Variables

For the dashboard to authenticate with protected APIs, set environment variables in Cloudflare Pages:

#### Via Cloudflare Dashboard
1. Go to Cloudflare Pages dashboard
2. Select your project (e.g., `truthscan-dashboard-prod`)
3. Go to Settings > Environment Variables
4. Add:
   - `VITE_BASIC_AUTH_USERNAME` = your_username
   - `VITE_BASIC_AUTH_PASSWORD` = your_password

#### Via Command Line
```bash
# Set for production Pages project
wrangler pages secret put VITE_BASIC_AUTH_USERNAME --project-name truthscan-dashboard-prod
wrangler pages secret put VITE_BASIC_AUTH_PASSWORD --project-name truthscan-dashboard-prod
```

## 🔍 Testing Deployments

### Worker Testing
```bash
# Test development worker
curl https://truthscan-twitter-bot.your-subdomain.workers.dev/

# Test staging worker
curl https://truthscan-twitter-bot-staging.your-subdomain.workers.dev/

# Test production worker
curl https://truthscan-twitter-bot-prod.your-subdomain.workers.dev/

# Test protected API endpoints (if Basic Auth configured)
curl -u "username:password" https://your-worker.workers.dev/api/detections
```

### Dashboard Testing
After deployment, dashboards will be available at:
- Development: `https://truthscan-dashboard.pages.dev`
- Staging: `https://truthscan-dashboard-staging.pages.dev`
- Production: `https://truthscan-dashboard-prod.pages.dev`

### Database Testing
```bash
# Test database connectivity
curl https://your-worker.workers.dev/api/test-db

# Check recent detections
curl https://your-worker.workers.dev/api/detections
```

## 📊 Monitoring & Logs

### View Worker Logs
```bash
# Development logs
pnpm worker:logs

# Production logs  
cd apps/worker && wrangler tail --env production

# Staging logs
cd apps/worker && wrangler tail --env staging
```

### Check Worker Status
```bash
# Check authentication and secrets
pnpm worker:status

# List all secrets for an environment
cd apps/worker && wrangler secret list --env production
```

### Cloudflare Dashboard
Monitor your deployments in the Cloudflare dashboard:
- **Workers**: Analytics, logs, and performance metrics
- **Pages**: Build history, deployment status, and analytics
- **D1**: Database queries, storage usage, and performance

## 🚨 Troubleshooting

### Common Issues

#### "Failed to publish your Function"
- Check that all required secrets are set for the target environment
- Verify the database ID is correct in wrangler.jsonc
- Ensure you're authenticated: `wrangler whoami`

#### "Build failed" for Pages
- Check that the build command works locally: `pnpm dashboard:build`
- Verify environment variables are set correctly
- Check build logs in Cloudflare Pages dashboard

#### "Database not found"
- Create the database for the target environment
- Update the database_id in wrangler.jsonc
- Run the schema migration: `wrangler d1 execute DB_NAME --file=./schema.sql`

#### API endpoints return 401/403
- Verify Basic Auth secrets are set if authentication is enabled
- Check that dashboard environment variables match worker secrets
- Test API endpoints directly with curl

### Rollback Procedure

#### Worker Rollback
```bash
# View deployment history
cd apps/worker && wrangler deployments list

# Rollback to previous version
cd apps/worker && wrangler rollback [DEPLOYMENT_ID]
```

#### Pages Rollback
1. Go to Cloudflare Pages dashboard
2. Select your project
3. Go to Deployments tab
4. Click "Rollback" on a previous successful deployment

## 🔄 CI/CD Integration

### GitHub Actions Example

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloudflare

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
          
      - name: Install dependencies
        run: pnpm install:all
        
      - name: Build and test
        run: pnpm test:build
        
      - name: Deploy to staging
        if: github.event_name == 'pull_request'
        run: pnpm deploy:staging
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          
      - name: Deploy to production
        if: github.ref == 'refs/heads/main'
        run: pnpm deploy:prod
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## 📚 Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Pages Documentation](https://developers.cloudflare.com/pages/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)
- [D1 Database Documentation](https://developers.cloudflare.com/d1/)
- [Project Security Guide](apps/worker/SECURITY.md) 