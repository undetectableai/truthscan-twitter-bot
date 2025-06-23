# Truthscan Twitter Bot

**Real-time AI image detection for Twitter using Cloudflare Workers and React**

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![React](https://img.shields.io/badge/React-18-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![License](https://img.shields.io/badge/License-MIT-green)

Truthscan is an intelligent Twitter bot that automatically detects AI-generated images in real-time. When mentioned in a tweet with an image, it analyzes the image using AI detection APIs and responds with the detection results.

## 🌟 Features

- **🤖 Real-time AI Detection**: Analyzes images for AI generation using Undetectable.AI
- **🐦 Twitter Integration**: Responds to mentions automatically with detection results  
- **📊 Analytics Dashboard**: Beautiful React dashboard with charts and detection history
- **🔒 Secure**: Comprehensive secrets management and optional API protection
- **⚡ Fast**: Built on Cloudflare Workers for global edge performance
- **📱 Responsive**: Mobile-friendly dashboard with real-time updates
- **🛡️ Production Ready**: Multi-environment deployment with monitoring

## 🏗️ Architecture

```
📦 truthscan-twitter-bot/
├── 🔧 apps/
│   ├── 📊 dashboard/          # React dashboard (Cloudflare Pages)
│   │   ├── src/components/    # Chart components, layout
│   │   ├── src/pages/         # Dashboard, analytics, settings
│   │   └── package.json       # Dashboard dependencies
│   └── ⚡ worker/             # Cloudflare Worker (API & bot logic)
│       ├── src/index.ts       # Main worker code
│       ├── scripts/           # Setup and deployment scripts
│       ├── wrangler.jsonc     # Worker configuration
│       └── package.json       # Worker dependencies
├── 📚 Documentation/
│   ├── DEPLOYMENT.md          # Comprehensive deployment guide
│   ├── apps/worker/SECURITY.md  # Security setup and best practices
│   └── apps/worker/README.md    # Worker-specific documentation
└── 🔧 Configuration/
    ├── package.json           # Workspace management
    ├── pnpm-workspace.yaml    # PNPM workspace config
    └── tsconfig.json          # TypeScript configuration
```

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ and **pnpm** 8+
- **Cloudflare account** with Workers and Pages access
- **Twitter Developer account** with API access
- **Undetectable.AI account** for image detection

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/your-username/truthscan-twitter-bot.git
cd truthscan-twitter-bot

# Install dependencies
pnpm install

# Authenticate with Cloudflare
wrangler auth login
```

### 2. Environment Setup

```bash
# Set up secrets interactively (recommended)
pnpm setup

# Or configure manually (see apps/worker/.env.example)
cd apps/worker
wrangler secret put TWITTER_API_KEY
# ... (continue with other secrets)
```

### 3. Database Setup

```bash
# Create and migrate database
pnpm db:setup
```

### 4. Development

```bash
# Start both worker and dashboard
pnpm dev

# Or start individually
pnpm worker:dev      # Worker on localhost:8787
pnpm dashboard:dev   # Dashboard on localhost:3001
```

### 5. Deployment

```bash
# Deploy to development
pnpm deploy

# Deploy to production
pnpm deploy:prod
```

**For detailed setup and deployment instructions, see [DEPLOYMENT.md](DEPLOYMENT.md)**

## 🚀 GitHub Actions Deployment (Recommended)

For automated deployment, set up GitHub Actions to deploy your bot automatically when you push to the main branch:

### Quick Setup

1. **Install GitHub CLI** (if not already installed):
   ```bash
   # macOS
   brew install gh
   
   # Or download from https://cli.github.com/
   ```

2. **Authenticate with GitHub**:
   ```bash
   gh auth login
   ```

3. **Set up all secrets automatically**:
   ```bash
   # Ensure you have a .env file with all your secrets
   ./scripts/setup-github-secrets.sh
   ```

4. **Push to trigger deployment**:
   ```bash
   git add .
   git commit -m "feat: set up GitHub Actions deployment"
   git push origin main
   ```

### What You Get

- ✅ **Automatic deployment** on every push to main
- ✅ **Lint and type-check** before deployment
- ✅ **Secrets management** through GitHub
- ✅ **Build status badges** and detailed logs
- ✅ **Rollback capability** if needed

### Manual Secret Setup

If you prefer to set up secrets manually:

1. Go to your repository **Settings** → **Secrets and variables** → **Actions**
2. Add the following secrets:
   - `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token
   - `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID
   - All your Twitter API credentials
   - Your Undetectable.AI API key

**For complete instructions, see [GITHUB_DEPLOYMENT.md](GITHUB_DEPLOYMENT.md)**

## 📋 Configuration

### Required Secrets

The bot requires several API keys and secrets. See individual app documentation:

- **Worker Secrets**: [apps/worker/.env.example](apps/worker/.env.example)
- **Dashboard Environment Variables**: [apps/dashboard/.env.example](apps/dashboard/.env.example)

### Twitter Setup

1. Create a Twitter App at [developer.twitter.com](https://developer.twitter.com/)
2. Enable "Read and Write" permissions
3. Generate API keys and access tokens
4. Configure the bot username in your app settings

## 🛠️ Development

### Available Scripts

#### Root Level (Workspace Management)
```bash
pnpm dev                    # Start both apps in development
pnpm build                  # Build both applications
pnpm lint                   # Lint all code
pnpm test:build            # Test all builds
pnpm deploy                 # Deploy both to development
pnpm deploy:prod           # Deploy both to production
```

#### Worker Commands
```bash
pnpm worker:dev            # Start worker development server
pnpm worker:deploy         # Deploy worker
pnpm worker:logs           # View worker logs
pnpm worker:status         # Check authentication and secrets
```

#### Dashboard Commands
```bash
pnpm dashboard:dev         # Start dashboard development server
pnpm dashboard:build       # Build dashboard
pnpm dashboard:deploy      # Deploy dashboard to Pages
```

#### Database Commands
```bash
pnpm db:setup              # Create and migrate database
pnpm db:migrate            # Apply schema changes
```

### Project Structure

- **`apps/worker/`** - Cloudflare Worker handling Twitter integration and AI detection
- **`apps/dashboard/`** - React dashboard for viewing detection analytics
- **Root configuration** - Workspace management and shared tooling

## 🔐 Security

Security is a top priority. The project includes:

- **Secrets Management**: All credentials stored as Cloudflare secrets
- **API Protection**: Optional Basic Authentication for dashboard APIs
- **Input Validation**: Proper request validation and sanitization
- **Rate Limiting**: Respects Twitter API rate limits

**For detailed security setup, see [apps/worker/SECURITY.md](apps/worker/SECURITY.md)**

## 🚀 Deployment

The project supports multiple deployment environments:

- **Development** - Local testing and development
- **Staging** - Pre-production testing
- **Production** - Live production environment

Each environment has separate:
- Cloudflare Worker instances
- D1 databases
- Pages deployments
- Secret configurations

**For complete deployment instructions, see [DEPLOYMENT.md](DEPLOYMENT.md)**

## 📊 Monitoring

### Worker Monitoring
```bash
pnpm worker:logs           # Real-time logs
pnpm worker:status         # Check status and secrets
```

### Cloudflare Dashboard
- **Workers**: Analytics, logs, performance metrics
- **Pages**: Build history, deployment status
- **D1**: Database queries, storage usage

## 🐛 Troubleshooting

### Common Issues

**"Unable to connect to API"**
- Ensure the worker is running: `pnpm worker:dev`
- Check worker status: `pnpm worker:status`
- Verify secrets are configured

**"Authentication required"**
- Configure Basic Auth credentials (optional)
- Check dashboard environment variables
- See [SECURITY.md](apps/worker/SECURITY.md) for details

**"Database not found"**
- Run database setup: `pnpm db:setup`
- Check D1 configuration in `apps/worker/wrangler.jsonc`

### Getting Help

1. Check the relevant documentation:
   - [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment issues
   - [apps/worker/SECURITY.md](apps/worker/SECURITY.md) - Security and secrets
   - [apps/worker/README.md](apps/worker/README.md) - Worker-specific issues
2. Review worker logs: `pnpm worker:logs`
3. Check Cloudflare dashboard for errors
4. Open an issue with detailed error information

## 🤝 Contributing

**New to the project?** Start with our [Developer Onboarding Guide](DEVELOPER_GUIDE.md) for complete setup instructions.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Install dependencies: `pnpm install`
4. Make your changes following the existing code style
5. Run tests: `pnpm test:build`
6. Commit your changes: `git commit -m 'Add amazing feature'`
7. Push to the branch: `git push origin feature/amazing-feature`
8. Open a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Run `pnpm lint` before committing
- Add tests for new features
- Update documentation for API changes
- Use conventional commit messages

## 📚 Documentation

- **[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)** - Complete developer onboarding guide
- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Complete deployment guide
- **[GITHUB_DEPLOYMENT.md](GITHUB_DEPLOYMENT.md)** - GitHub Actions deployment setup
- **[apps/worker/SECURITY.md](apps/worker/SECURITY.md)** - Security setup and best practices
- **[apps/worker/README.md](apps/worker/README.md)** - Worker documentation
- **[apps/worker/D1_SETUP.md](apps/worker/D1_SETUP.md)** - Database setup guide

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Cloudflare** for the incredible Workers and Pages platform
- **Undetectable.AI** for the AI detection API
- **Twitter** for the API access
- **React** and **TypeScript** communities for excellent tooling

---

**Built with ❤️ using Cloudflare Workers, React, and TypeScript**

---

## 🚀 Deployment Status

GitHub Actions deployment pipeline is now active! Any push to the main branch will automatically deploy to Cloudflare Workers. 