# Twitter API Proxy

A simple Node.js proxy server that forwards requests to the Twitter API with IPv4 support.

## Purpose

This proxy solves IPv6 connectivity issues when calling the Twitter API from environments that only support IPv6 (like some Cloudflare Workers deployments).

## Features

- IPv4 forwarding to Twitter API
- CORS support
- Header preservation
- Health check endpoint
- Error handling and logging

## Endpoints

- `GET /health` - Health check endpoint
- `ALL /twitter-api/*` - Proxy endpoint for Twitter API calls

## Usage

The proxy accepts requests on `/twitter-api/*` and forwards them to `https://api.twitter.com/*`.

For example:
- `GET /twitter-api/2/tweets/search/recent` → `GET https://api.twitter.com/2/tweets/search/recent`

## Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (default: development)

## Deployment

This app is designed to be deployed on DigitalOcean's App Platform.

## Local Development

```bash
npm install
npm start
```

The server will start on port 3000 by default. 