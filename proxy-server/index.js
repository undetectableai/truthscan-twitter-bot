const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Twitter API proxy endpoint
app.all('/twitter-api/*', async (req, res) => {
  try {
    // Extract the path after /twitter-api/
    const twitterPath = req.path.replace('/twitter-api/', '');
    const twitterUrl = `https://api.twitter.com/${twitterPath}`;
    
    // Forward query parameters
    const url = new URL(twitterUrl);
    Object.keys(req.query).forEach(key => {
      url.searchParams.append(key, req.query[key]);
    });

    console.log(`Proxying ${req.method} request to: ${url.toString()}`);

    // Prepare headers (exclude host and other proxy-specific headers)
    const headers = {};
    Object.keys(req.headers).forEach(key => {
      if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(key.toLowerCase())) {
        headers[key] = req.headers[key];
      }
    });

    // Make the request to Twitter API
    const response = await fetch(url.toString(), {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      // Force IPv4 by using the family option
      family: 4
    });

    // Forward response headers
    Object.keys(response.headers.raw()).forEach(key => {
      const value = response.headers.raw()[key];
      if (Array.isArray(value)) {
        value.forEach(val => res.setHeader(key, val));
      } else {
        res.setHeader(key, value);
      }
    });

    // Set response status
    res.status(response.status);

    // Forward response body
    const responseText = await response.text();
    res.send(responseText);

  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Catch-all for other routes
app.all('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not found', 
    message: 'Use /twitter-api/* endpoints to proxy to Twitter API',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Twitter API proxy server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Twitter API proxy: http://localhost:${PORT}/twitter-api/*`);
}); 