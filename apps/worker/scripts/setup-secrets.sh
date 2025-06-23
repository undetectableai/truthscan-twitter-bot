#!/bin/bash

# Truthscan Twitter Bot - Secrets Setup Script
# This script helps configure all required secrets for the Cloudflare Worker

set -e

echo "🔐 Truthscan Twitter Bot - Secrets Setup"
echo "========================================"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: Wrangler CLI is not installed"
    echo "Please install it first: npm install -g wrangler"
    exit 1
fi

# Check if user is authenticated
if ! wrangler whoami &> /dev/null; then
    echo "❌ Error: Not authenticated with Cloudflare"
    echo "Please authenticate first: wrangler auth login"
    exit 1
fi

echo "✅ Wrangler CLI detected and authenticated"
echo ""

# Function to set a secret
set_secret() {
    local secret_name=$1
    local description=$2
    local optional=${3:-false}
    
    echo "📝 Setting up: $secret_name"
    echo "   Description: $description"
    
    if [ "$optional" = "true" ]; then
        echo "   (Optional - skip if not needed)"
        read -p "   Do you want to set this secret? (y/N): " -r
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "   ⏭️  Skipped"
            echo ""
            return
        fi
    fi
    
    echo "   Enter the secret value (input will be hidden):"
    read -s -p "   > " secret_value
    echo ""
    
    if [ -z "$secret_value" ]; then
        echo "   ⚠️  Empty value provided, skipping..."
        echo ""
        return
    fi
    
    # Set the secret using wrangler
    if echo "$secret_value" | wrangler secret put "$secret_name" > /dev/null 2>&1; then
        echo "   ✅ Successfully set $secret_name"
    else
        echo "   ❌ Failed to set $secret_name"
    fi
    echo ""
}

echo "🚀 Starting secrets configuration..."
echo ""

# Twitter API Secrets (Required)
echo "🐦 Twitter API Credentials"
echo "-------------------------"
echo "You need to create a Twitter App at: https://developer.twitter.com/en/apps"
echo ""

set_secret "TWITTER_API_KEY" "Twitter API Key (Consumer Key)"
set_secret "TWITTER_API_KEY_SECRET" "Twitter API Key Secret (Consumer Secret)"
set_secret "TWITTER_BEARER_TOKEN" "Twitter Bearer Token"
set_secret "TWITTER_ACCESS_TOKEN" "Twitter Access Token"
set_secret "TWITTER_ACCESS_TOKEN_SECRET" "Twitter Access Token Secret"

echo ""

# AI Detection API Secret (Required)
echo "🤖 AI Detection API"
echo "------------------"
echo "Get your API key from: https://ai-image-detect.undetectable.ai"
echo ""

set_secret "AI_DETECTION_API_KEY" "Undetectable.AI API Key"

echo ""

# Dashboard Protection (Optional)
echo "🔒 Dashboard Protection (Optional)"
echo "--------------------------------"
echo "These credentials will protect your API endpoints with Basic Authentication"
echo ""

set_secret "BASIC_AUTH_USERNAME" "Username for API access" true
set_secret "BASIC_AUTH_PASSWORD" "Password for API access" true

echo ""
echo "🎉 Secrets setup complete!"
echo ""
echo "Next steps:"
echo "1. Deploy your worker: wrangler deploy"
echo "2. Test the webhook endpoint"
echo "3. Configure Twitter webhook URL in your Twitter App"
echo ""
echo "For more information, see: apps/worker/README.md" 