#!/bin/bash

# Start Wrangler dev server from the correct directory
cd "$(dirname "$0")"
echo "Starting wrangler dev server from: $(pwd)"
npx wrangler dev --port 8787 