# Truthscan Twitter Bot - Developer Onboarding Guide

**Complete guide for developers joining the Truthscan project**

Welcome to the Truthscan Twitter Bot development team! This guide will walk you through everything you need to know to get up and running with the project, from initial setup to deploying your first changes.

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Project Architecture](#project-architecture)
4. [Development Workflow](#development-workflow)
5. [Testing & Quality Checks](#testing--quality-checks)
6. [Deployment Process](#deployment-process)
7. [Troubleshooting](#troubleshooting)
8. [Best Practices](#best-practices)
9. [Additional Resources](#additional-resources)

## 🔧 Prerequisites

Before you begin, ensure you have the following installed and configured on your development machine:

### Required Software

- **Node.js** 18.0.0 or higher ([Download here](https://nodejs.org/))
- **pnpm** 8.0.0 or higher (Install: `npm install -g pnpm`)
- **Git** (for version control)
- **A code editor** (VS Code recommended)

### Required Accounts

- **Cloudflare Account** with Workers and Pages access
- **Twitter Developer Account** with API access
- **Undetectable.AI Account** for image detection API

### Verify Prerequisites

```bash
# Check Node.js version
node --version  # Should be >= 18.0.0

# Check pnpm version
pnpm --version  # Should be >= 8.0.0

# Check Git
git --version
```

## 🚀 Initial Setup

### 1. Clone the Repository

```bash
# Clone the repository
git clone https://github.com/your-organization/truthscan-twitter-bot.git
cd truthscan-twitter-bot

# Install all dependencies
pnpm install
```

### 2. Authenticate with Cloudflare

```bash
# Authenticate with Cloudflare
wrangler auth login

# Verify authentication
wrangler whoami
```

### 3. Set Up Environment Variables

The project uses different environment files for different components:

#### Worker Environment Setup

```bash
# Navigate to worker directory
cd apps/worker

# Interactive setup (recommended for new developers)
pnpm setup:secrets

# Or manual setup (see apps/worker/.env.example for all required secrets)
wrangler secret put TWITTER_API_KEY
wrangler secret put TWITTER_API_KEY_SECRET
# ... (continue with other secrets)
```

#### Dashboard Environment Setup

```bash
# Navigate to dashboard directory
cd apps/dashboard

# Copy example environment file
cp .env.example .env.local

# Edit .env.local with your values
# VITE_API_BASE_URL=http://localhost:8787
# VITE_BASIC_AUTH_USERNAME=your_username
# VITE_BASIC_AUTH_PASSWORD=your_password
```

### 4. Database Setup

```bash
# From project root
pnpm db:setup

# This will:
# 1. Create D1 databases for all environments
# 2. Run initial migrations
# 3. Set up database bindings
```

### 5. Verify Installation

```bash
# Run build check to verify everything is set up correctly
pnpm test:build

# Expected output: ✅ All builds successful
```

## 🏗️ Project Architecture

Understanding the project structure is crucial for effective development:

### Monorepo Structure

```
📦 truthscan-twitter-bot/
├── 🔧 apps/
│   ├── 📊 dashboard/          # React dashboard (Cloudflare Pages)
│   │   ├── src/components/    # Reusable UI components
│   │   ├── src/pages/         # Dashboard pages (analytics, settings)
│   │   └── package.json       # Dashboard dependencies
│   └── ⚡ worker/             # Cloudflare Worker (API & bot logic)
│       ├── src/index.ts       # Main worker entry point
│       ├── scripts/           # Setup and deployment scripts
│       └── package.json       # Worker dependencies
├── 📚 Documentation/
├── 🔧 Configuration/
└── 🧪 Tests/
```

### Technology Stack

- **Backend**: Cloudflare Workers (TypeScript)
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Charts**: Recharts
- **API Integration**: Twitter API v2, Undetectable.AI
- **Deployment**: Cloudflare Workers + Pages
- **Package Manager**: pnpm (workspace support)

### Key Concepts

- **Worker**: Handles Twitter API integration, AI detection, and API endpoints
- **Dashboard**: Provides analytics and monitoring interface
- **D1 Database**: Stores detection history and deduplication data
- **Secrets**: API keys stored securely using Wrangler secrets
- **Multi-environment**: Development, staging, and production configurations

## 💻 Development Workflow

### Daily Development Process

#### 1. Start Development Environment

```bash
# From project root, start both worker and dashboard
pnpm dev

# This runs:
# - Worker on http://localhost:8787
# - Dashboard on http://localhost:3001

# Or start individually:
pnpm worker:dev      # Just the worker
pnpm dashboard:dev   # Just the dashboard
```

#### 2. Development Best Practices

- **Follow TypeScript**: Use strict typing, avoid `any` types
- **Lint Before Committing**: Run `pnpm lint` to catch issues early
- **Test Builds**: Run `pnpm test:build` to verify everything compiles
- **Check Logs**: Monitor worker logs with `pnpm worker:logs`

#### 3. Making Changes

**Worker Changes:**
```bash
# Navigate to worker directory
cd apps/worker

# Make your changes to src/index.ts or other files
# Worker will auto-reload on file changes

# Check TypeScript compilation
pnpm build:check

# Test API endpoints
curl http://localhost:8787/api/detections
```

**Dashboard Changes:**
```bash
# Navigate to dashboard directory
cd apps/dashboard

# Make your changes to src/ files
# Dashboard will auto-reload with hot module replacement

# Check TypeScript compilation
pnpm build:check

# Test build process
pnpm build
```

#### 4. Database Changes

```bash
# Modify schema.sql in apps/worker/
# Then apply changes:

# Local development database
pnpm --filter worker run db:migrate:local

# Development environment database
pnpm --filter worker run db:migrate

# Test the changes
pnpm --filter worker run test:db
```

## 🧪 Testing & Quality Checks

### Automated Checks

Before committing any code, run these checks:

```bash
# Run all quality checks
pnpm lint                # ESLint across all apps
pnpm test:build         # TypeScript compilation + build test
pnpm build:check        # Detailed build verification

# Individual app checks
pnpm --filter worker run lint     # Worker linting
pnpm --filter dashboard run lint  # Dashboard linting
```

### Manual Testing

#### Worker Testing

```bash
# Start worker in development
pnpm worker:dev

# Test API endpoints
curl http://localhost:8787/api/test-db    # Database connectivity
curl http://localhost:8787/api/detections # Recent detections

# Test webhook (if applicable)
curl -X POST http://localhost:8787/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

#### Dashboard Testing

```bash
# Start dashboard
pnpm dashboard:dev

# Open http://localhost:3001 in browser
# Test all pages:
# - Dashboard (charts and recent detections)
# - Analytics (detailed statistics)
# - Settings (configuration options)

# Test API connectivity with authentication
```

### Error Scenarios

Test common error scenarios:

- **API failures**: Temporarily disable network to test error handling
- **Authentication issues**: Test with invalid credentials
- **Rate limiting**: Verify rate limit handling works correctly
- **Database errors**: Test with invalid database queries

## 🚀 Deployment Process

The project supports three environments with automated deployment scripts:

### Environment Overview

| Environment | Purpose | Worker Name | Database | Pages Project |
|------------|---------|-------------|----------|---------------|
| **Development** | Local testing | `truthscan-twitter-bot` | `truthscan-db` | `truthscan-dashboard` |
| **Staging** | Pre-production testing | `truthscan-twitter-bot-staging` | `truthscan-db-staging` | `truthscan-dashboard-staging` |
| **Production** | Live production | `truthscan-twitter-bot-prod` | `truthscan-db-prod` | `truthscan-dashboard-prod` |

### Deployment Commands

#### Quick Deployment (Development)

```bash
# Deploy both worker and dashboard to development
pnpm deploy

# This runs:
# 1. Build verification and linting
# 2. Worker deployment
# 3. Dashboard build and deployment
```

#### Staging Deployment

```bash
# Deploy to staging environment
pnpm deploy:staging

# This creates separate staging instances for testing
```

#### Production Deployment

```bash
# Deploy to production (use with caution)
pnpm deploy:prod

# Recommended: Deploy staging first, test, then production
pnpm deploy:staging
# ... test staging environment ...
pnpm deploy:prod
```

#### Individual App Deployment

```bash
# Deploy only the worker
pnpm worker:deploy              # Development
pnpm worker:deploy:staging      # Staging
pnpm worker:deploy:prod         # Production

# Deploy only the dashboard
pnpm dashboard:deploy           # Development
pnpm dashboard:deploy:staging   # Staging
pnpm dashboard:deploy:prod      # Production
```

### Environment-Specific Secrets

Each environment needs its own set of secrets:

```bash
# Development (default)
wrangler secret put TWITTER_API_KEY

# Staging
wrangler secret put TWITTER_API_KEY --env staging

# Production
wrangler secret put TWITTER_API_KEY --env production
```

### Pre-Deployment Checklist

Before deploying to production:

- [ ] All tests pass (`pnpm test:build`)
- [ ] No linting errors (`pnpm lint`)
- [ ] Changes tested in staging environment
- [ ] Database migrations applied if needed
- [ ] Secrets configured for target environment
- [ ] Documentation updated if needed

## 🐛 Troubleshooting

### Common Issues and Solutions

#### "Unable to connect to API"

```bash
# Check if worker is running
pnpm worker:status

# Verify secrets are configured
wrangler secret list

# Check worker logs
pnpm worker:logs
```

#### "Authentication required"

```bash
# Verify Basic Auth credentials match between worker and dashboard
# Worker secrets:
wrangler secret list | grep BASIC_AUTH

# Dashboard environment variables:
cat apps/dashboard/.env.local | grep VITE_BASIC_AUTH
```

#### "Database not found"

```bash
# Create databases if they don't exist
pnpm db:setup

# Check D1 configuration
cat apps/worker/wrangler.jsonc | grep -A 10 d1_databases
```

#### "Build failures"

```bash
# Clear cache and rebuild
pnpm clean
pnpm install
pnpm build

# Check specific app
pnpm --filter worker run build:check
pnpm --filter dashboard run build:check
```

#### "Deployment failures"

```bash
# Check authentication
wrangler whoami

# Verify project names and bindings
cat apps/worker/wrangler.jsonc

# Check deployment logs
wrangler tail --env production
```

### Getting Help

1. **Check Documentation**:
   - [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment issues
   - [apps/worker/SECURITY.md](apps/worker/SECURITY.md) - Security setup
   - [apps/worker/README.md](apps/worker/README.md) - Worker details

2. **Debug Tools**:
   ```bash
   pnpm worker:logs     # Real-time worker logs
   pnpm worker:status   # Authentication and secrets status
   ```

3. **Team Communication**:
   - Create GitHub issues for bugs
   - Use team chat for quick questions
   - Schedule code review sessions for complex changes

## ✅ Best Practices

### Code Quality

- **TypeScript**: Use strict types, no `any` unless absolutely necessary
- **Error Handling**: Always handle potential errors gracefully
- **Logging**: Use descriptive console logs for debugging
- **Comments**: Document complex business logic
- **Naming**: Use descriptive variable and function names

### Git Workflow

```bash
# Create feature branch from main
git checkout -b feature/your-feature-name

# Make small, focused commits
git add .
git commit -m "feat: add user authentication validation"

# Keep commits atomic and descriptive
# Use conventional commit messages:
# feat: new feature
# fix: bug fix
# docs: documentation
# style: formatting
# refactor: code restructuring
# test: adding tests
# chore: maintenance
```

### Security Practices

- **Never commit secrets**: Use `.env.example` for documentation only
- **Use environment-specific secrets**: Different keys for dev/staging/prod
- **Validate input**: Always validate and sanitize user input
- **Rate limiting**: Respect API rate limits
- **HTTPS only**: Use secure connections for all external APIs

### Performance Optimization

- **Worker optimization**: Minimize cold start times
- **Database queries**: Use efficient SQL queries
- **Caching**: Cache frequently accessed data
- **Bundle size**: Keep dashboard bundle size minimal
- **Error boundaries**: Implement proper error boundaries in React

### Testing Strategy

- **Unit tests**: Test individual functions and components
- **Integration tests**: Test API endpoints and database interactions
- **End-to-end tests**: Test complete user workflows
- **Error scenarios**: Test failure cases and edge conditions

## 📚 Additional Resources

### Documentation

- **Project Docs**:
  - [README.md](README.md) - Project overview
  - [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment guide
  - [apps/worker/SECURITY.md](apps/worker/SECURITY.md) - Security setup

### External Resources

- **Cloudflare**:
  - [Workers Documentation](https://developers.cloudflare.com/workers/)
  - [D1 Database Guide](https://developers.cloudflare.com/d1/)
  - [Pages Deployment](https://developers.cloudflare.com/pages/)

- **Twitter API**:
  - [Twitter API v2 Documentation](https://developer.twitter.com/en/docs/twitter-api)
  - [Rate Limits](https://developer.twitter.com/en/docs/twitter-api/rate-limits)

- **Development Tools**:
  - [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
  - [React Documentation](https://react.dev/)
  - [TypeScript Handbook](https://www.typescriptlang.org/docs/)

### Team Resources

- **Code Style Guide**: [Internal style guide link]
- **Design System**: [Design system documentation]
- **Team Slack**: [#truthscan-dev channel]
- **Issue Tracking**: [GitHub Issues](https://github.com/your-org/truthscan-twitter-bot/issues)

## 🎯 Next Steps

After completing this onboarding guide:

1. **Set up your development environment** following the steps above
2. **Make a small test change** to familiarize yourself with the workflow
3. **Deploy to staging** to understand the deployment process
4. **Review the codebase** to understand the architecture
5. **Join team meetings** and introduce yourself
6. **Pick up your first ticket** from the project board

Welcome to the team! 🎉

---

**Questions?** Don't hesitate to ask in the team chat or create a GitHub issue. We're here to help you succeed!

**Last Updated**: 2024-12-23 