#!/bin/bash

# GitHub Secrets Setup Script for Truthscan Twitter Bot
# This script reads secrets from .env file and sets them in the GitHub repository
# Prerequisites: GitHub CLI (gh) installed and authenticated

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if GitHub CLI is installed and authenticated
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    if ! command -v gh &> /dev/null; then
        print_error "GitHub CLI (gh) is not installed. Please install it from https://cli.github.com/"
        exit 1
    fi
    
    if ! gh auth status &> /dev/null; then
        print_error "GitHub CLI is not authenticated. Please run 'gh auth login' first."
        exit 1
    fi
    
    print_success "GitHub CLI is installed and authenticated"
}

# Get repository info
get_repo_info() {
    print_status "Getting repository information..."
    
    REPO_INFO=$(gh repo view --json nameWithOwner,owner,name -q '.nameWithOwner,.owner.login,.name' 2>/dev/null || echo "")
    
    if [ -z "$REPO_INFO" ]; then
        print_error "Could not determine repository information. Make sure you're in a Git repository with a GitHub remote."
        exit 1
    fi
    
    REPO_FULL_NAME=$(echo "$REPO_INFO" | head -n1)
    REPO_OWNER=$(echo "$REPO_INFO" | sed -n '2p')
    REPO_NAME=$(echo "$REPO_INFO" | sed -n '3p')
    
    print_success "Repository: $REPO_FULL_NAME"
}

# Check if .env file exists
check_env_file() {
    ENV_FILE=".env"
    
    if [ ! -f "$ENV_FILE" ]; then
        print_error ".env file not found in current directory"
        print_status "Please create a .env file with your secrets. Example:"
        echo ""
        echo "CLOUDFLARE_API_TOKEN=your_cloudflare_api_token"
        echo "CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id"
        echo "TWITTER_BEARER_TOKEN=your_twitter_bearer_token"
        echo "TWITTER_CONSUMER_KEY=your_twitter_consumer_key"
        echo "TWITTER_CONSUMER_SECRET=your_twitter_consumer_secret"
        echo "TWITTER_ACCESS_TOKEN=your_twitter_access_token"
        echo "TWITTER_ACCESS_TOKEN_SECRET=your_twitter_access_token_secret"
        echo "TWITTER_WEBHOOK_SECRET=your_webhook_secret"
        echo "UNDETECTABLE_AI_API_KEY=your_undetectable_ai_api_key"
        echo ""
        exit 1
    fi
    
    print_success "Found .env file"
}

# List of required secrets for the Truthscan Twitter Bot
REQUIRED_SECRETS=(
    "CLOUDFLARE_API_TOKEN"
    "CLOUDFLARE_ACCOUNT_ID"
    "TWITTER_BEARER_TOKEN"
    "TWITTER_CONSUMER_KEY"
    "TWITTER_CONSUMER_SECRET"
    "TWITTER_ACCESS_TOKEN"
    "TWITTER_ACCESS_TOKEN_SECRET"
    "TWITTER_WEBHOOK_SECRET"
    "UNDETECTABLE_AI_API_KEY"
)

# Check which secrets are present in .env file
check_required_secrets() {
    print_status "Checking for required secrets in .env file..."
    
    MISSING_SECRETS=()
    
    for secret in "${REQUIRED_SECRETS[@]}"; do
        if ! grep -q "^${secret}=" "$ENV_FILE"; then
            MISSING_SECRETS+=("$secret")
        fi
    done
    
    if [ ${#MISSING_SECRETS[@]} -gt 0 ]; then
        print_warning "Missing secrets in .env file:"
        for secret in "${MISSING_SECRETS[@]}"; do
            echo "  - $secret"
        done
        echo ""
        read -p "Do you want to continue with only the available secrets? (y/N): " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_status "Please add the missing secrets to your .env file and run the script again."
            exit 1
        fi
    else
        print_success "All required secrets found in .env file"
    fi
}

# Set secrets in GitHub repository
set_github_secrets() {
    print_status "Setting secrets in GitHub repository: $REPO_FULL_NAME"
    echo ""
    
    SUCCESS_COUNT=0
    FAIL_COUNT=0
    
    # Read .env file and process each line
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip empty lines and comments
        line=$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        if [ -z "$line" ] || [[ "$line" =~ ^# ]]; then
            continue
        fi
        
        # Skip VITE_ variables (client-side environment variables)
        if [[ "$line" =~ ^VITE_ ]]; then
            print_warning "Skipping client-side variable: $(echo "$line" | cut -d'=' -f1)"
            continue
        fi
        
        # Parse key=value
        if [[ "$line" =~ ^([^=]+)=(.*)$ ]]; then
            SECRET_NAME="${BASH_REMATCH[1]}"
            SECRET_VALUE="${BASH_REMATCH[2]}"
            
            # Remove surrounding quotes if present
            SECRET_VALUE=$(echo "$SECRET_VALUE" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
            
            # Skip empty values
            if [ -z "$SECRET_VALUE" ]; then
                print_warning "Skipping $SECRET_NAME (empty value)"
                continue
            fi
            
            print_status "Setting secret: $SECRET_NAME"
            
            if echo "$SECRET_VALUE" | gh secret set "$SECRET_NAME" --repo "$REPO_FULL_NAME"; then
                print_success "✓ $SECRET_NAME"
                ((SUCCESS_COUNT++))
            else
                print_error "✗ Failed to set $SECRET_NAME"
                ((FAIL_COUNT++))
            fi
        else
            print_warning "Skipping malformed line: $line"
        fi
    done < "$ENV_FILE"
    
    echo ""
    print_status "Summary:"
    print_success "Successfully set: $SUCCESS_COUNT secrets"
    if [ $FAIL_COUNT -gt 0 ]; then
        print_error "Failed to set: $FAIL_COUNT secrets"
    fi
}

# List current secrets (names only, not values)
list_current_secrets() {
    print_status "Current secrets in repository:"
    echo ""
    
    if gh secret list --repo "$REPO_FULL_NAME" 2>/dev/null; then
        echo ""
    else
        print_warning "Could not list current secrets (this is normal for some repositories)"
        echo ""
    fi
}

# Main execution
main() {
    echo "🔐 GitHub Secrets Setup Script for Truthscan Twitter Bot"
    echo "========================================================"
    echo ""
    
    check_prerequisites
    get_repo_info
    check_env_file
    check_required_secrets
    
    echo ""
    print_status "This will set the following secrets in your GitHub repository:"
    for secret in "${REQUIRED_SECRETS[@]}"; do
        if grep -q "^${secret}=" "$ENV_FILE"; then
            echo "  ✓ $secret"
        else
            echo "  ✗ $secret (missing from .env)"
        fi
    done
    echo ""
    
    read -p "Do you want to continue? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_status "Aborted by user"
        exit 0
    fi
    
    echo ""
    set_github_secrets
    
    echo ""
    list_current_secrets
    
    echo ""
    print_success "🚀 GitHub secrets setup complete!"
    print_status "Next steps:"
    echo "  1. Push your code to the main branch to trigger the first deployment"
    echo "  2. Go to the Actions tab in your GitHub repository to monitor the deployment"
    echo "  3. Check the Cloudflare Workers dashboard to see your deployed worker"
    echo ""
    print_status "For more information, see GITHUB_DEPLOYMENT.md"
}

# Run main function
main "$@" 