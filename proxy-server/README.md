# Twitter API Proxy Server

A simple Express.js proxy server that forwards requests to the Twitter API. This proxy helps bypass CORS restrictions and can be deployed to cloud platforms like DigitalOcean.

## Features

- Forwards all HTTP methods (GET, POST, PUT, DELETE, etc.) to Twitter API
- Handles query parameters and request headers
- Provides CORS support for browser-based applications
- Health check endpoint for monitoring
- Compatible with Node.js 14+ environments

## Dependencies

- **Express.js**: Web framework for handling HTTP requests
- **Axios**: HTTP client for making requests to Twitter API (replaces node-fetch for better compatibility)
- **CORS**: Cross-Origin Resource Sharing middleware

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

The server will run on port 3000 by default, or the port specified in the `PORT` environment variable.

## Usage

### Health Check
```
GET /health
```

### Twitter API Proxy
All requests to `/twitter-api/*` are forwarded to `https://api.twitter.com/*`

Examples:
- `GET /twitter-api/2/users/by/username/truth_scan` → `https://api.twitter.com/2/users/by/username/truth_scan`
- `GET /twitter-api/2/tweets/search/recent?query=@truth_scan` → `https://api.twitter.com/2/tweets/search/recent?query=@truth_scan`

## Deployment

### Docker
```bash
docker build -t twitter-proxy .
docker run -p 3000:3000 twitter-proxy
```

### DigitalOcean App Platform
1. Connect your repository to DigitalOcean App Platform
2. Set the source directory to `/proxy-server`
3. The app will automatically use the Dockerfile for deployment

## Troubleshooting

### "fetch is not a function" Error
This error was resolved by replacing `node-fetch` with `axios`. The issue occurred because:
- node-fetch v3+ only supports ES modules
- Many cloud platforms use older Node.js versions or CommonJS environments
- axios provides better compatibility across different hosting environments

### IPv4 vs IPv6 Issues
If you encounter networking issues, the proxy server uses axios which typically handles IP version selection automatically. For specific IPv4 requirements, additional configuration may be needed.

### CORS Issues
The proxy includes CORS middleware that allows requests from any origin. Modify the CORS configuration in `index.js` if you need to restrict access.

## Environment Variables

- `PORT`: Server port (default: 3000)

## API Response Format

The proxy forwards responses exactly as received from the Twitter API, including:
- Status codes
- Response headers
- Response body (JSON or text)

Error responses from the proxy itself use this format:
```json
{
  "error": "Error type",
  "message": "Detailed error message",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
``` 