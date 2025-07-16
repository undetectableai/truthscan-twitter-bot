# Video Thumbnail Support

## Overview

The Truthscan Twitter Bot now supports analyzing video thumbnails from Twitter posts! When someone tags the bot on a post containing a video, the bot will automatically extract the video's thumbnail image and run it through the AI image detector.

## How It Works

### Video Thumbnail Extraction

Twitter provides thumbnail images for all videos posted to their platform. These thumbnails are accessible through the `preview_image_url` field in the Twitter API response for video media types.

The bot now handles the following media types:
- **Photos** (`type: 'photo'`) - Direct image analysis (existing functionality)  
- **Videos** (`type: 'video'`) - Thumbnail image analysis (NEW!)
- **Animated GIFs** (`type: 'animated_gif'`) - Thumbnail image analysis (NEW!)

### API Compatibility

The implementation works with both Twitter API versions:

**Twitter API v2:**
- Requests `media.fields=url,preview_image_url,type` 
- Uses `preview_image_url` for video thumbnails
- Falls back to `url` field if `preview_image_url` is unavailable

**Twitter API v1.1 (Fallback):**
- Uses `media_url_https` as both direct image URL and video thumbnail
- Handles conversion between v1.1 and v2 formats seamlessly

### Processing Flow

1. **Media Detection**: Bot detects mention with video content
2. **Thumbnail Extraction**: Extracts video thumbnail URL using `preview_image_url`
3. **AI Analysis**: Downloads thumbnail and runs through Undetectable.AI detector
4. **Response**: Replies with AI detection results for the video thumbnail
5. **Page Creation**: Creates shareable results page with thumbnail analysis

## Technical Implementation

### Updated Interfaces

```typescript
interface TwitterMedia {
  id: number;
  media_url_https: string;
  type: string;
  preview_image_url?: string; // NEW: For video thumbnails
}
```

### Enhanced Extraction Logic

The `extractImageUrls()` function now processes:

```typescript
for (const media of mediaEntities) {
  if (media.type === 'photo') {
    // Direct photo processing
    imageUrls.push(media.media_url_https);
  } else if (media.type === 'video' || media.type === 'animated_gif') {
    // Video thumbnail processing
    if (media.preview_image_url) {
      imageUrls.push(media.preview_image_url);
    } else {
      imageUrls.push(media.media_url_https); // Fallback
    }
  }
}
```

### Logging and Debugging

Enhanced logging helps track video thumbnail processing:
- `📹 Using video thumbnail: {url}` - When preview_image_url is used
- `📹 Using video fallback URL: {url}` - When falling back to media_url_https  
- Updated media debugging to show both `url` and `preview_url` fields

## User Experience

From the user's perspective, video support is completely seamless:

1. **Tag the bot** on any tweet containing a video
2. **Get instant results** - Bot analyzes the video thumbnail and replies
3. **View detailed analysis** - Click through to see full detection results

The bot treats video thumbnails exactly like regular images, so all existing features work:
- AI detection scoring
- Confidence analysis  
- Shareable results pages
- Dashboard analytics

## Benefits

- **Expanded Coverage**: Bot can now analyze any visual content on Twitter
- **Seamless Experience**: Videos work exactly like photos from user perspective  
- **Better Detection**: Catches AI-generated video thumbnails and covers
- **Complete Analysis**: Full Groq image analysis on video thumbnails
- **Backward Compatible**: Existing photo functionality unchanged

## Example Use Cases

- Detecting AI-generated video thumbnails
- Analyzing promotional video covers  
- Checking video preview images for manipulation
- Covering all visual content types in mentions

The video thumbnail feature significantly expands the bot's utility while maintaining the same simple user experience! 