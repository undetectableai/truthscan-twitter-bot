# TruthScan API Integration Guide

This guide explains how to integrate with the TruthScan API to create detection result pages programmatically. The API automatically processes images with AI detection and analysis - you only need to provide the image and API key!

## How It Works

1. **Send Image**: Submit an image via URL or file upload
2. **AI Processing**: TruthScan automatically runs AI detection analysis
3. **Rich Descriptions**: Groq AI generates detailed image descriptions and analysis
4. **Page Creation**: A shareable results page is created with all analysis data

## API Endpoint

**URL:** `https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page`  
**Method:** `POST`  
**Authentication:** API Key required

## Authentication

Include your API key in the request headers:

```
X-API-Key: your_api_key_here
```

Or:

```
Authorization: Bearer your_api_key_here
```

## Approach 1: JSON with Image URL

Use this approach when you have a publicly accessible image URL.

### Content Type
```
Content-Type: application/json
```

### Request Body
```json
{
  "imageUrl": "https://example.com/path/to/image.jpg",
  "metadata": {
    "userAgent": "MyApp/1.0",
    "sourceType": "website_upload",
    "referrer": "https://myapp.com/analyze"
  }
}
```

### Example (cURL)
```bash
curl -X POST "https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "imageUrl": "https://example.com/image.jpg"
  }'
```

### Example (JavaScript)
```javascript
const response = await fetch('https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'your_api_key_here'
  },
  body: JSON.stringify({
    imageUrl: 'https://example.com/image.jpg',
    metadata: {
      sourceType: 'my_app',
      userAgent: 'MyApp/1.0'
    }
  })
});

const result = await response.json();
console.log('Page created:', result.pageUrl);
```

## Approach 2: Multipart/Form-Data with Image Blob

Use this approach when you have image file data and want to upload it directly.

### Content Type
```
Content-Type: multipart/form-data
```

### Form Fields
- **`image`** (File): The image file to analyze
- **`metadata`** (JSON String, Optional): Additional metadata

### Example (cURL)
```bash
curl -X POST "https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page" \
  -H "X-API-Key: your_api_key_here" \
  -F "image=@/path/to/image.jpg" \
  -F 'metadata={"sourceType": "file_upload"}'
```

### Example (JavaScript with File Input)
```javascript
const formData = new FormData();
formData.append('image', fileInput.files[0]);
formData.append('metadata', JSON.stringify({
  sourceType: 'user_upload',
  userAgent: 'MyApp/1.0'
}));

const response = await fetch('https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key_here'
  },
  body: formData
});

const result = await response.json();
console.log('Page created:', result.pageUrl);
```

### Example (Node.js with File System)
```javascript
import fs from 'fs';
import FormData from 'form-data';

const form = new FormData();
form.append('image', fs.createReadStream('/path/to/image.jpg'));
form.append('metadata', JSON.stringify({
  sourceType: 'server_upload'
}));

const response = await fetch('https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key_here',
    ...form.getHeaders()
  },
  body: form
});
```

## Required Fields

### JSON Approach
- **`imageUrl`** (string): Publicly accessible image URL

### Multipart Approach
- **`image`** (File): Image file to analyze

## Optional Fields

### Metadata Object (Both Approaches)
- **`userAgent`** (string): Client user agent
- **`sourceType`** (string): Source identifier (e.g., "website", "mobile_app")
- **`referrer`** (string): Referring URL

## Image Requirements

### Supported Formats
- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- WebP (.webp)

### Size Limits
- Maximum file size: **10MB**
- Recommended: Under 5MB for optimal performance

### URL Requirements (JSON approach)
- Must be publicly accessible
- Must return proper image Content-Type headers
- HTTPS recommended for security

## Response Format

### Success Response
```json
{
  "success": true,
  "pageId": "abc1",
  "pageUrl": "https://truthscan.com/d/abc1",
  "message": "Results page created successfully",
  "processing": {
    "aiProbability": 0.85,
    "finalResult": "AI Generated",
    "confidence": 0.8,
    "processingTimeMs": 2500
  }
}
```

### Error Response
```json
{
  "error": "Error type",
  "message": "Human-readable error message",
  "details": "Additional technical details (optional)"
}
```

## Error Codes

| Status | Error Type | Description |
|--------|------------|-------------|
| 400 | Missing image file/URL | Image is required |
| 400 | Invalid image type | Unsupported image format |
| 400 | Image file too large | Exceeds 10MB size limit |
| 400 | Invalid image URL | URL not accessible or not an image |
| 401 | Unauthorized | Invalid or missing API key |
| 413 | Payload too large | Request body exceeds limits |
| 429 | Rate limit exceeded | Too many requests |
| 500 | AI processing failed | Server-side AI analysis error |

## What Gets Generated Automatically

When you submit an image, TruthScan automatically generates:

### AI Detection Analysis
- **AI Probability Score**: 0.0-1.0 likelihood of being AI-generated
- **Final Result**: "AI Generated", "Human Created", or "Uncertain"
- **Confidence Level**: Overall confidence in the analysis

### Rich Descriptions (Powered by Groq AI)
- **Image Description**: What the image shows
- **Meta Description**: SEO-optimized description
- **Detailed Analysis**: In-depth explanation of detection findings
- **Confidence Analysis**: Why the AI reached its conclusion

### Generated Page Features
- **Professional Layout**: Clean, shareable results page
- **Social Media Ready**: Optimized meta tags and Open Graph data
- **Mobile Responsive**: Works perfectly on all devices
- **SEO Optimized**: Search engine friendly
- **Direct Image Display**: Images served directly from TruthScan

## Best Practices

### Performance
- Use compressed images when possible
- Prefer WebP format for smaller file sizes
- Keep images under 5MB for fastest processing

### Security
- Always use HTTPS for image URLs
- Don't expose sensitive data in image URLs
- Validate file types on your end before upload

### Error Handling
```javascript
try {
  const response = await fetch(apiUrl, options);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`API Error: ${error.message}`);
  }
  
  const result = await response.json();
  return result;
} catch (error) {
  console.error('TruthScan API failed:', error);
  // Handle error appropriately
}
```

### Rate Limiting
The API enforces rate limits:
- **100 requests per minute** per API key
- **1000 requests per hour** per API key

Monitor your usage and implement exponential backoff for retries.

## Example Integration

Here's a complete example showing how to integrate TruthScan into a web application:

```javascript
class TruthScanAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://truthscan-twitter-bot.bjuhasz08.workers.dev';
  }

  async analyzeImage(imageFile) {
    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('metadata', JSON.stringify({
      sourceType: 'web_app',
      userAgent: navigator.userAgent
    }));

    const response = await fetch(`${this.baseUrl}/api/create-results-page`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey
      },
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Analysis failed: ${error.message}`);
    }

    return await response.json();
  }

  async analyzeImageUrl(imageUrl) {
    const response = await fetch(`${this.baseUrl}/api/create-results-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      },
      body: JSON.stringify({
        imageUrl,
        metadata: {
          sourceType: 'web_app'
        }
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Analysis failed: ${error.message}`);
    }

    return await response.json();
  }
}

// Usage
const truthscan = new TruthScanAPI('your_api_key_here');

// Analyze uploaded file
const result = await truthscan.analyzeImage(fileInput.files[0]);
console.log('Results page:', result.pageUrl);

// Analyze image URL
const result = await truthscan.analyzeImageUrl('https://example.com/image.jpg');
console.log('AI Probability:', result.processing.aiProbability);
```

## Support

For API support, integration help, or to request additional features:
- Email: support@truthscan.com
- Documentation: https://docs.truthscan.com
- Status Page: https://status.truthscan.com 