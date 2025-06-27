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