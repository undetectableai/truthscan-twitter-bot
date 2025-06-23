# GitHub Actions Deployment Guide

This guide explains how to set up automatic deployment of your Truthscan Twitter Bot to Cloudflare Workers using GitHub Actions.

## Overview

The GitHub Actions workflow will:
1. **Run on every push to `main` branch** - automatically deploy your changes
2. **Run on pull requests** - test the code but don't deploy
3. **Lint and type-check** your code before deployment
4. **Deploy to Cloudflare Workers** using the official Cloudflare action

## Required GitHub Secrets

You need to set up the following secrets in your GitHub repository:

### 1. Go to Repository Settings
1. Navigate to your GitHub repository
2. Click on **Settings** tab
3. In the left sidebar, click **Secrets and variables** → **Actions**
4. Click **New repository secret** for each secret below

### 2. Cloudflare Secrets

**CLOUDFLARE_API_TOKEN**
- Go to [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
- Click **Create Token**
- Use the **"Edit Cloudflare Workers"** template
- **Account:** Select your account
- **Zone:** Select "All zones" or specific zones you need
- **Continue to summary** → **Create Token**
- Copy the token and add it as a GitHub secret

**CLOUDFLARE_ACCOUNT_ID**
- Go to your [Cloudflare Dashboard](https://dash.cloudflare.com/)
- On the right sidebar, copy your **Account ID**
- Add it as a GitHub secret

### 3. Twitter API Secrets

Add all your Twitter API credentials as GitHub secrets:

**TWITTER_BEARER_TOKEN**
- Your Twitter API Bearer Token

**TWITTER_CONSUMER_KEY**
- Your Twitter API Consumer Key (API Key)

**TWITTER_CONSUMER_SECRET**
- Your Twitter API Consumer Secret (API Secret)

**TWITTER_ACCESS_TOKEN**
- Your Twitter API Access Token

**TWITTER_ACCESS_TOKEN_SECRET**
- Your Twitter API Access Token Secret

**TWITTER_WEBHOOK_SECRET**
- A secure random string for webhook validation (generate a strong password)

### 4. AI Detection API Secret

**UNDETECTABLE_AI_API_KEY**
- Your Undetectable.AI API key

## How the Deployment Works

### Workflow Triggers
- **Push to `main`**: Runs lint/type-check, then deploys if successful
- **Pull Request**: Runs lint/type-check only (no deployment)

### Steps
1. **Checkout code** from GitHub
2. **Setup Node.js and pnpm** with dependency caching
3. **Install dependencies** in the worker directory
4. **Run linting** to check code quality
5. **Run type checking** to ensure TypeScript compilation
6. **Deploy to Cloudflare** (only on main branch pushes)
7. **Update Worker secrets** automatically during deployment

### Deployment Process
The GitHub Action uses the official `cloudflare/wrangler-action@v3` which:
- Automatically runs `wrangler deploy` in your worker directory
- Updates all your Worker secrets with the values from GitHub secrets
- Provides deployment status and logs

## Usage

### Normal Development Workflow
1. **Create a feature branch**: `git checkout -b feature/my-feature`
2. **Make your changes** and commit them
3. **Create a pull request** to `main`
4. The workflow will **run tests automatically** on your PR
5. **Merge the PR** when ready
6. The workflow will **automatically deploy** to production

### Manual Deployment
If you need to deploy manually, you can still use:
```bash
cd apps/worker
pnpm run deploy
```

But the GitHub Actions approach is recommended for consistency and safety.

## Monitoring Deployments

### GitHub Actions
- Go to your repository's **Actions** tab
- Click on any workflow run to see detailed logs
- Green checkmark = successful deployment
- Red X = failed deployment (check logs for errors)

### Cloudflare Dashboard
- Go to [Cloudflare Workers Dashboard](https://dash.cloudflare.com/workers)
- Click on your worker to see deployment status, logs, and metrics
- Use **Quick Edit** to make emergency fixes if needed

## Adding a Status Badge

After setting up GitHub Actions, you can add a status badge to your README:

```markdown
![Deploy Status](https://github.com/YOUR_USERNAME/YOUR_REPO_NAME/workflows/Deploy%20to%20Cloudflare%20Workers/badge.svg)
```

Replace `YOUR_USERNAME` and `YOUR_REPO_NAME` with your actual GitHub username and repository name.

## Security Best Practices

### Secrets Management
- **Never commit secrets** to your repository
- All secrets are **encrypted** by GitHub and only accessible during workflow runs
- Secrets are **automatically injected** into your Worker during deployment
- Use **least privilege** for your Cloudflare API token (only Workers permissions)

### Branch Protection
Consider setting up branch protection rules:
1. Go to **Settings** → **Branches**
2. Add rule for `main` branch
3. Enable **"Require status checks to pass before merging"**
4. Select the **lint-and-test** check
5. This prevents broken code from being deployed

## Troubleshooting

### Common Issues

**Deployment fails with "No account id found"**
- Check that `CLOUDFLARE_ACCOUNT_ID` secret is set correctly
- Verify the account ID in your Cloudflare dashboard

**Authentication errors**
- Verify `CLOUDFLARE_API_TOKEN` has correct permissions
- Token should have "Edit Cloudflare Workers" permissions
- Check token hasn't expired

**Lint or type-check failures**
- Run `pnpm run lint` and `pnpm run type-check` locally first
- Fix any errors before pushing
- Use `pnpm run lint:fix` to auto-fix some issues

**Secret update failures**
- Make sure all secret names in GitHub match the ones in the workflow
- Check that secret values are correct (no extra spaces, quotes, etc.)

### Getting Help
- Check the **Actions** tab for detailed error logs
- Review **Cloudflare Workers** logs in the dashboard
- Compare your secrets with the ones listed in this guide

## Environment Variables vs Secrets

**In GitHub (all are secrets):**
- All sensitive data should be stored as GitHub repository secrets
- This includes API keys, tokens, and any other sensitive configuration

**In Cloudflare Worker:**
- GitHub secrets become Cloudflare Worker secrets automatically
- Access them in your code via `env.SECRET_NAME`
- No need to manually update Worker secrets - the deployment does it automatically

## Next Steps

After setting up GitHub Actions deployment:
1. **Test the workflow** by making a small change and pushing to main
2. **Monitor the deployment** in both GitHub Actions and Cloudflare dashboard
3. **Set up branch protection** rules for additional safety
4. **Consider staging environment** for testing changes before production

Your deployment pipeline is now automated! 🚀 