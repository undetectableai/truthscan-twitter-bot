# TruthScan Results Page API Integration Guide

I need you to integrate with the TruthScan Results Page API to create shareable detection result pages for our image detector. This API allows us to generate beautiful, SEO-optimized results pages hosted on TruthScan's infrastructure.

## API Overview

**Purpose**: Create shareable results pages for AI detection results from our main website's image detector.

**What it does**: 
- Takes detection results from our website
- Creates a professional results page on `truthscan.com/d/{pageId}`
- Returns the shareable URL for social media, sharing, etc.

## API Specification

### Endpoint
```
POST https://truthscan.com/bot-api/create-results-page
```

### Authentication
```
X-API-Key: tsk_fb4e4edd34a6398924716057ca83129b5df296074eb370a252da469c4e071de4
```

### Request Headers
```
Content-Type: application/json
X-API-Key: tsk_fb4e4edd34a6398924716057ca83129b5df296074eb370a252da469c4e071de4
```

### Request Body Schema
```typescript
interface CreateResultsPageRequest {
  imageUrl: string;                    // REQUIRED: URL to the analyzed image
  detection: {
    aiProbability: number;             // REQUIRED: 0.0-1.0 (e.g., 0.85 = 85% AI)
    finalResult: string;               // REQUIRED: "AI Generated" | "Human Created" | "Inconclusive"
    confidence: number;                // REQUIRED: 0.0-1.0 confidence score
    processingTimeMs?: number;         // OPTIONAL: How long detection took
  };
  analysis: {
    imageDescription: string;          // REQUIRED: What the image shows
    metaDescription: string;           // REQUIRED: SEO description for social sharing
    detailedDescription?: string;      // OPTIONAL: Longer analysis
    confidenceAnalysis?: string;       // OPTIONAL: Why this confidence level
  };
  metadata?: {
    sourceType?: string;               // OPTIONAL: "web_upload" | "url_analysis" etc.
    userAgent?: string;                // OPTIONAL: User's browser
    referrer?: string;                 // OPTIONAL: Where they came from
  };
}
```

### Response Schema
```typescript
interface CreateResultsPageResponse {
  success: true;
  pageId: string;                      // Short ID like "a8vt"
  pageUrl: string;                     // Full URL: "https://truthscan.com/d/a8vt"
}

// Error Response
interface ErrorResponse {
  success: false;
  error: string;
  message: string;
}
```

## Implementation Examples

### Basic Integration (JavaScript/TypeScript)

```typescript
async function createTruthScanResultsPage(detectionResult: any, imageUrl: string): Promise<string | null> {
  const API_KEY = 'tsk_fb4e4edd34a6398924716057ca83129b5df296074eb370a252da469c4e071de4';
  const API_URL = 'https://truthscan.com/bot-api/create-results-page';
  
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({
        imageUrl: imageUrl,
        detection: {
          aiProbability: detectionResult.aiProbability,        // Your detection score
          finalResult: detectionResult.finalResult,            // Your classification
          confidence: detectionResult.confidence,              // Your confidence
          processingTimeMs: detectionResult.processingTime,    // Optional
        },
        analysis: {
          imageDescription: detectionResult.description || 'Image analysis',
          metaDescription: `${Math.round(detectionResult.aiProbability * 100)}% AI-generated with ${Math.round(detectionResult.confidence * 100)}% confidence`,
        },
        metadata: {
          sourceType: 'web_upload',
          userAgent: navigator.userAgent,
          referrer: document.referrer || 'direct',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const result = await response.json();
    
    if (result.success) {
      return result.pageUrl;  // "https://truthscan.com/d/abc123"
    } else {
      console.error('TruthScan API error:', result.error);
      return null;
    }
  } catch (error) {
    console.error('Failed to create TruthScan results page:', error);
    return null;
  }
}
```

### React Hook Example

```typescript
import { useState } from 'react';

export function useTruthScanResults() {
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createResultsPage = async (detectionResult: any, imageUrl: string) => {
    setIsCreating(true);
    setError(null);
    
    try {
      const truthScanUrl = await createTruthScanResultsPage(detectionResult, imageUrl);
      return truthScanUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    } finally {
      setIsCreating(false);
    }
  };

  return { createResultsPage, isCreating, error };
}
```

### Next.js API Route Example

```typescript
// pages/api/create-truthscan-page.ts or app/api/create-truthscan-page/route.ts
export async function POST(request: Request) {
  try {
    const { detectionResult, imageUrl } = await request.json();
    
    const truthScanUrl = await createTruthScanResultsPage(detectionResult, imageUrl);
    
    if (truthScanUrl) {
      return Response.json({ success: true, url: truthScanUrl });
    } else {
      return Response.json({ success: false, error: 'Failed to create results page' }, { status: 500 });
    }
  } catch (error) {
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
```

## Integration Points

### 1. After Image Detection
```typescript
// After your AI detection completes
const detectionComplete = async (result: DetectionResult, imageFile: File) => {
  // Upload image to your CDN/storage first
  const imageUrl = await uploadImageToStorage(imageFile);
  
  // Create TruthScan results page
  const truthScanUrl = await createTruthScanResultsPage(result, imageUrl);
  
  if (truthScanUrl) {
    // Show share buttons, add to results, etc.
    setShareableUrl(truthScanUrl);
  }
};
```

### 2. Share Button Component
```typescript
interface ShareButtonProps {
  truthScanUrl: string;
  detectionResult: any;
}

export function ShareButton({ truthScanUrl, detectionResult }: ShareButtonProps) {
  const shareText = `I just analyzed an image with AI detection: ${Math.round(detectionResult.aiProbability * 100)}% AI-generated`;
  
  return (
    <div className="share-buttons">
      <a 
        href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(truthScanUrl)}&text=${encodeURIComponent(shareText)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Share on Twitter
      </a>
      
      <button onClick={() => navigator.clipboard.writeText(truthScanUrl)}>
        Copy Link
      </button>
    </div>
  );
}
```

## Error Handling

```typescript
async function createTruthScanResultsPageWithRetry(detectionResult: any, imageUrl: string, maxRetries = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await createTruthScanResultsPage(detectionResult, imageUrl);
      return result;
    } catch (error) {
      console.warn(`TruthScan API attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        console.error('All TruthScan API attempts failed');
        return null;
      }
      
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return null;
}
```

## Testing

### Test Data
```typescript
const testDetectionResult = {
  aiProbability: 0.87,
  finalResult: "AI Generated",
  confidence: 0.92,
  processingTime: 2500,
  description: "A realistic portrait showing signs of AI generation"
};

const testImageUrl = "https://your-domain.com/uploads/test-image.jpg";
```

### Test Call
```typescript
// Test the integration
const testTruthScanIntegration = async () => {
  const url = await createTruthScanResultsPage(testDetectionResult, testImageUrl);
  console.log('Created TruthScan page:', url);
  // Should return something like: "https://truthscan.com/d/abc123"
};
```

## Security & Best Practices

1. **API Key Security**: Store the API key in environment variables, never in client-side code
2. **Rate Limiting**: The API has built-in rate limiting (100 requests/minute)
3. **Image URLs**: Ensure your image URLs are publicly accessible for the results page
4. **Error Handling**: Always handle API failures gracefully
5. **Validation**: Validate your detection data before sending to the API

## Required Environment Variables

```bash
# Add to your .env file
TRUTHSCAN_API_KEY=tsk_fb4e4edd34a6398924716057ca83129b5df296074eb370a252da469c4e071de4
TRUTHSCAN_API_URL=https://truthscan.com/bot-api/create-results-page
```

## User Experience Flow

1. User uploads image to your detector
2. Your AI analyzes the image
3. You call TruthScan API to create results page
4. Show user the shareable link
5. User can share on social media, copy link, etc.

## Example Result Page

The API creates pages like this: https://truthscan.com/d/a8vt

Features:
- Professional design
- SEO optimized
- Social media preview cards
- Mobile responsive
- Fast loading

## Example Request/Response

### Example Request
```json
{
  "imageUrl": "https://example.com/my-image.jpg",
  "detection": {
    "aiProbability": 0.87,
    "finalResult": "AI Generated",
    "confidence": 0.92,
    "processingTimeMs": 2500
  },
  "analysis": {
    "imageDescription": "A realistic portrait of a woman with striking blue eyes",
    "metaDescription": "87% AI-generated with 92% confidence - Realistic portrait analysis"
  },
  "metadata": {
    "sourceType": "web_upload",
    "userAgent": "Mozilla/5.0...",
    "referrer": "https://yoursite.com/detector"
  }
}
```

### Example Response
```json
{
  "success": true,
  "pageId": "a8vt",
  "pageUrl": "https://truthscan.com/d/a8vt"
}
```

### Example Error Response
```json
{
  "success": false,
  "error": "Invalid API key",
  "message": "The provided API key is not valid"
}
```

---

**Next Steps**: Implement the `createTruthScanResultsPage` function in your codebase and add share buttons to your detection results interface.

## Quick Implementation Checklist

- [ ] Add API key to environment variables
- [ ] Implement `createTruthScanResultsPage` function
- [ ] Add error handling with retries
- [ ] Integrate into your detection workflow
- [ ] Add share buttons to results UI
- [ ] Test with sample data
- [ ] Deploy and verify in production

## Support

If you encounter any issues with the API integration:
1. Check that your API key is correct
2. Verify your image URLs are publicly accessible
3. Ensure your request format matches the schema
4. Check rate limiting (100 requests/minute)
5. Review error responses for specific issues 

# TruthScan API Integration Guide

This guide explains how to integrate with the TruthScan API to create detection result pages programmatically. The API now supports **two different approaches** for submitting images:

1. **JSON with Image URL** (Original approach)
2. **Multipart/Form-Data with Image Blob** (New approach)

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
  "detection": {
    "aiProbability": 0.85,
    "finalResult": "AI Generated",
    "confidence": 0.9,
    "processingTimeMs": 1500
  },
  "analysis": {
    "imageDescription": "A digital artwork showing a modern cityscape",
    "metaDescription": "AI-generated cityscape with 85% AI probability",
    "detailedDescription": "This image displays characteristics typical of AI-generated content, including subtle pattern inconsistencies and digital artifacts.",
    "confidenceAnalysis": "Multiple indicators suggest AI generation: consistent lighting patterns, digital texture qualities, and compositional elements typical of diffusion models."
  },
  "metadata": {
    "userAgent": "TruthScan Web App 1.0",
    "referrer": "https://yoursite.com/detection",
    "sourceType": "web_upload"
  }
}
```

### Example (JavaScript/Node.js)

```javascript
async function createDetectionPageWithURL(imageUrl, detectionResults) {
  const response = await fetch('https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'your_api_key_here'
    },
    body: JSON.stringify({
      imageUrl: imageUrl,
      detection: detectionResults,
      analysis: {
        imageDescription: "Generated by your AI analysis",
        // ... other analysis fields
      },
      metadata: {
        sourceType: "your_app_name"
      }
    })
  });

  const result = await response.json();
  return result.pageUrl; // https://truthscan.com/d/abc123
}
```

## Approach 2: Multipart/Form-Data with Image Blob

**NEW:** Use this approach when you have image data directly (File, Blob, or binary data) without needing to host it publicly first.

### Content Type
```
Content-Type: multipart/form-data
```

### Form Fields

1. **`image`** (File): The image file (JPEG, PNG, GIF, WebP)
2. **`metadata`** (String): JSON string containing detection results and analysis

### Supported Image Formats
- JPEG (`image/jpeg`)
- PNG (`image/png`)
- GIF (`image/gif`)
- WebP (`image/webp`)

### Size Limits
- Maximum file size: **10MB**

### Example (JavaScript/Browser)

```javascript
async function createDetectionPageWithBlob(imageFile, detectionResults) {
  const formData = new FormData();
  
  // Add the image file
  formData.append('image', imageFile);
  
  // Add metadata as JSON string
  const metadata = {
    detection: detectionResults,
    analysis: {
      imageDescription: "Generated by your AI analysis",
      metaDescription: "Brief description for SEO",
      detailedDescription: "Detailed analysis of why this appears AI-generated",
      confidenceAnalysis: "Technical explanation of detection confidence"
    },
    metadata: {
      userAgent: navigator.userAgent,
      sourceType: "web_upload"
    }
  };
  
  formData.append('metadata', JSON.stringify(metadata));
  
  const response = await fetch('https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page', {
    method: 'POST',
    headers: {
      'X-API-Key': 'your_api_key_here'
      // Note: Don't set Content-Type - let browser set it with boundary
    },
    body: formData
  });

  const result = await response.json();
  return result.pageUrl; // https://truthscan.com/d/abc123
}
```

### Example (Node.js with form-data)

```javascript
const FormData = require('form-data');
const fs = require('fs');

async function createDetectionPageWithFile(imagePath, detectionResults) {
  const form = new FormData();
  
  // Add the image file
  form.append('image', fs.createReadStream(imagePath));
  
  // Add metadata as JSON string
  const metadata = {
    detection: detectionResults,
    analysis: {
      imageDescription: "Generated by your AI analysis",
      // ... other fields
    },
    metadata: {
      sourceType: "server_upload"
    }
  };
  
  form.append('metadata', JSON.stringify(metadata));
  
  const response = await fetch('https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page', {
    method: 'POST',
    headers: {
      'X-API-Key': 'your_api_key_here',
      ...form.getHeaders()
    },
    body: form
  });

  const result = await response.json();
  return result.pageUrl;
}
```

### Example (Python with requests)

```python
import requests
import json

def create_detection_page_with_file(image_path, detection_results):
    url = 'https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page'
    
    # Prepare metadata
    metadata = {
        'detection': detection_results,
        'analysis': {
            'imageDescription': 'Generated by your AI analysis',
            # ... other fields
        },
        'metadata': {
            'sourceType': 'python_upload'
        }
    }
    
    # Prepare files and data
    files = {
        'image': open(image_path, 'rb'),
        'metadata': (None, json.dumps(metadata))
    }
    
    headers = {
        'X-API-Key': 'your_api_key_here'
    }
    
    response = requests.post(url, files=files, headers=headers)
    result = response.json()
    
    return result.get('pageUrl')
```

## Required Fields

### Detection Object (Required)
```json
{
  "aiProbability": 0.0-1.0,     // 0.85 = 85% AI probability
  "finalResult": "string",       // "AI Generated", "Human Created", etc.
  "confidence": 0.0-1.0,         // Overall confidence in detection
  "processingTimeMs": 1500       // Optional: processing time
}
```

### Analysis Object (Optional but Recommended)
```json
{
  "imageDescription": "string",     // Brief description of the image content
  "metaDescription": "string",      // SEO-friendly meta description
  "detailedDescription": "string",  // Detailed explanation of the image
  "confidenceAnalysis": "string"    // Technical explanation of confidence level
}
```

## Response Format

### Success Response (200)
```json
{
  "success": true,
  "pageId": "abc123",
  "pageUrl": "https://truthscan.com/d/abc123"
}
```

### Error Responses

#### Missing API Key (401)
```json
{
  "error": "API key required",
  "message": "Include X-API-Key header or Authorization: Bearer <key>"
}
```

#### Invalid Image (400)
```json
{
  "error": "Invalid image URL",
  "message": "The provided image URL is not accessible or downloadable: timeout error"
}
```

#### Invalid Image Type (400) - Blob uploads only
```json
{
  "error": "Invalid image type",
  "message": "Unsupported image type: image/svg+xml",
  "details": "Supported formats: JPEG, PNG, GIF, WebP"
}
```

#### File Too Large (400) - Blob uploads only
```json
{
  "error": "Image file too large",
  "message": "Image file size (15MB) exceeds 10MB limit"
}
```

#### Rate Limit (429)
```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Maximum 100 requests per minute."
}
```

## Complete Examples

### React Component with File Upload

```jsx
import React, { useState } from 'react';

function ImageUploader() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    
    try {
      // Your AI detection logic here
      const detectionResults = {
        aiProbability: 0.85,
        finalResult: "AI Generated",
        confidence: 0.9
      };

      const formData = new FormData();
      formData.append('image', file);
      formData.append('metadata', JSON.stringify({
        detection: detectionResults,
        analysis: {
          imageDescription: "AI-generated artwork",
          metaDescription: `AI detection result: ${Math.round(detectionResults.aiProbability * 100)}% AI probability`,
          detailedDescription: "Analysis shows characteristics consistent with AI generation",
          confidenceAnalysis: "High confidence based on pattern analysis"
        },
        metadata: {
          sourceType: "react_upload"
        }
      }));

      const response = await fetch('https://truthscan-twitter-bot.bjuhasz08.workers.dev/api/create-results-page', {
        method: 'POST',
        headers: {
          'X-API-Key': 'your_api_key_here'
        },
        body: formData
      });

      const data = await response.json();
      setResult(data);
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input 
        type="file" 
        accept="image/*"
        onChange={(e) => setFile(e.target.files[0])}
      />
      <button type="submit" disabled={!file || loading}>
        {loading ? 'Processing...' : 'Upload & Analyze'}
      </button>
      
      {result && (
        <div>
          {result.success ? (
            <p>Results page created: <a href={result.pageUrl} target="_blank" rel="noopener noreferrer">{result.pageUrl}</a></p>
          ) : (
            <p>Error: {result.message}</p>
          )}
        </div>
      )}
    </form>
  );
}

export default ImageUploader;
```

## Which Approach to Choose?

### Use **JSON with Image URL** when:
- ✅ Images are already hosted publicly
- ✅ Working with URLs from external sources
- ✅ Building server-to-server integrations
- ✅ Images are large (>10MB) and already optimized

### Use **Multipart/Form-Data with Blob** when:
- ✅ Users upload images directly to your app
- ✅ Images are generated programmatically
- ✅ You don't want to host images publicly
- ✅ Working with File objects in browsers
- ✅ Images are under 10MB

## Rate Limits

- **100 requests per minute** per API key
- Rate limits are enforced per API key, not per IP address

## CORS Support

The API supports CORS for web applications with these allowed origins:
- `https://truthscan.com`
- `https://www.truthscan.com`
- `https://staging.truthscan.com`
- `http://localhost:3000` (development)
- `http://localhost:3001` (development)

## Security Notes

1. **API Key Security**: Never expose your API key in client-side code
2. **Image Validation**: All images are validated for type, size, and accessibility
3. **Content Filtering**: Ensure uploaded content complies with terms of service
4. **Rate Limiting**: Implement client-side rate limiting to avoid hitting API limits

## Troubleshooting

### Common Issues

1. **"Invalid API key"**: Verify your API key is correct and included in headers
2. **"Image validation failed"**: Ensure image URLs are publicly accessible or files are valid image formats
3. **"Rate limit exceeded"**: Implement exponential backoff and respect rate limits
4. **CORS errors**: Ensure your domain is in the allowed origins list

### Getting Help

If you encounter issues:
1. Check the error message and status code
2. Verify your API key and request format
3. Test with the provided examples
4. Contact support with specific error details

## Changelog

### v2.0 (Latest)
- ✅ Added support for multipart/form-data with image blobs
- ✅ Added image type and size validation
- ✅ Enhanced error messages and validation
- ✅ Backward compatible with existing JSON API

### v1.0
- ✅ JSON API with image URL support
- ✅ Basic validation and error handling 