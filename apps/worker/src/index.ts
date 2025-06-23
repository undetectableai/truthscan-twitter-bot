/**
 * Truthscan Twitter Bot - Cloudflare Worker
 * Real-time AI image detection for Twitter mentions
 */

interface ScheduledEvent {
  readonly scheduledTime: number;
  readonly cron: string;
  waitUntil(promise: Promise<any>): void;
}

interface Env {
  // Cloudflare D1 database binding
  DB: D1Database;
  
  // Twitter API credentials (stored as Wrangler secrets)
  TWITTER_API_KEY: string;
  TWITTER_API_KEY_SECRET: string;
  TWITTER_BEARER_TOKEN: string;
  TWITTER_ACCESS_TOKEN: string;
  TWITTER_ACCESS_TOKEN_SECRET: string;
  
  // AI Detection API (Undetectable.AI)
  AI_DETECTION_API_KEY: string;
  
  // Bot configuration
  TWITTER_BOT_USERNAME: string;
  
  // Dashboard/API Protection (Optional)
  BASIC_AUTH_USERNAME?: string;
  BASIC_AUTH_PASSWORD?: string;
}

/**
 * Basic Authentication Middleware
 * Protects API endpoints with username/password authentication
 */
function requireBasicAuth(request: Request, env: Env): Response | null {
  // Skip authentication if credentials are not configured
  if (!env.BASIC_AUTH_USERNAME || !env.BASIC_AUTH_PASSWORD) {
    return null; // No authentication required
  }
  
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new Response('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Truthscan API"',
        'Content-Type': 'text/plain'
      }
    });
  }
  
  try {
    // Decode the base64 credentials
    const credentials = atob(authHeader.substring(6));
    const [username, password] = credentials.split(':');
    
    // Verify credentials
    if (username !== env.BASIC_AUTH_USERNAME || password !== env.BASIC_AUTH_PASSWORD) {
      return new Response('Invalid credentials', {
        status: 403,
        headers: {
          'WWW-Authenticate': 'Basic realm="Truthscan API"',
          'Content-Type': 'text/plain'
        }
      });
    }
    
    // Authentication successful
    return null;
    
  } catch (error) {
    console.error('Basic Auth error:', error);
    return new Response('Authentication error', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }
}

/**
 * Rate limiting tracker for Twitter API requests
 */
interface TwitterRateLimit {
  requestCount: number;
  windowStartTime: number;
}

// In-memory rate limiting (resets on worker restart)
const twitterRateLimit: TwitterRateLimit = {
  requestCount: 0,
  windowStartTime: Date.now()
};

/**
 * Check if we can make Twitter API requests within rate limits
 * Twitter Basic tier: 60 requests per 15 minutes
 */
function canMakeTwitterRequest(): boolean {
  const now = Date.now();
  const windowDuration = 15 * 60 * 1000; // 15 minutes in ms
  const maxRequests = 60;

  // Reset window if it's been more than 15 minutes
  if (now - twitterRateLimit.windowStartTime > windowDuration) {
    twitterRateLimit.requestCount = 0;
    twitterRateLimit.windowStartTime = now;
  }

  return twitterRateLimit.requestCount < maxRequests;
}

/**
 * Track that we made a Twitter API request
 */
function recordTwitterRequest(): void {
  twitterRateLimit.requestCount++;
}

/**
 * Check if a tweet has already been processed (deduplication)
 */
async function isAlreadyProcessed(tweetId: string, env: Env): Promise<boolean> {
  try {
    const result = await env.DB
      .prepare('SELECT COUNT(*) as count FROM detections WHERE tweet_id = ?')
      .bind(tweetId)
      .first();
    
    return (result?.count as number) > 0;
  } catch (error) {
    console.error('Error checking tweet deduplication:', error);
    return false; // Assume not processed if error occurs
  }
}

/**
 * Poll Twitter for recent mentions using the search API
 */
async function pollTwitterMentions(env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    console.log('Starting Twitter mention polling...');

    // Check rate limits
    if (!canMakeTwitterRequest()) {
      console.log('Twitter API rate limit reached, skipping polling cycle');
      return;
    }

    // Bot username from environment
    const botUsername = env.TWITTER_BOT_USERNAME || 'truth_scan';
    
    // Search for recent mentions using direct API call
    const searchQuery = `@${botUsername}`;
    console.log('Searching for mentions:', searchQuery);

    recordTwitterRequest();
    
    // Build Twitter API v2 search URL with parameters
    const searchUrl = new URL('https://api.twitter.com/2/tweets/search/recent');
    searchUrl.searchParams.set('query', searchQuery);
    searchUrl.searchParams.set('tweet.fields', 'id,text,author_id,created_at,attachments,referenced_tweets');
    searchUrl.searchParams.set('user.fields', 'username');
    searchUrl.searchParams.set('media.fields', 'url,preview_image_url,type');
    searchUrl.searchParams.set('expansions', 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.attachments.media_keys');
    searchUrl.searchParams.set('max_results', '10');
    searchUrl.searchParams.set('sort_order', 'recency');

    const response = await fetch(searchUrl.toString(), {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twitter API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const searchResults: TwitterV2SearchResponse = await response.json();

    console.log('Twitter search completed:', {
      resultCount: searchResults.data?.length || 0,
      rateLimit: twitterRateLimit
    });

    if (!searchResults.data || searchResults.data.length === 0) {
      console.log('No recent mentions found');
      return;
    }

    // Process each found mention
    const backgroundTasks: Promise<void>[] = [];
    
    for (const tweet of searchResults.data) {
      try {
        const tweetId = tweet.id;
        
        // Check for deduplication
        const alreadyProcessed = await isAlreadyProcessed(tweetId, env);
        if (alreadyProcessed) {
          console.log(`Tweet ${tweetId} already processed, skipping`);
          continue;
        }

        // Get user info from includes
        const author = searchResults.includes?.users?.find(
          user => user.id === tweet.author_id
        );
        const authorUsername = author?.username || 'unknown';

        // Check if this mention is a reply to another tweet
        const isReply = tweet.referenced_tweets?.some(ref => ref.type === 'replied_to');
        let imageUrls: string[] = [];
        
        if (isReply) {
          // Look for images in the original tweet that was replied to
          const referencedTweetId = tweet.referenced_tweets?.find(ref => ref.type === 'replied_to')?.id;
          
          if (referencedTweetId) {
            const originalTweet = searchResults.includes?.tweets?.find(
              t => t.id === referencedTweetId
            );
            
            if (originalTweet?.attachments?.media_keys) {
              const mediaObjects = searchResults.includes?.media?.filter(
                media => originalTweet.attachments!.media_keys.includes(media.media_key!)
              ) || [];
              
              imageUrls = mediaObjects
                .filter(media => media.type === 'photo')
                .map(media => media.url!)
                .filter(url => url);
                
              console.log('Found reply to tweet with images:', {
                originalTweetId: referencedTweetId,
                imageCount: imageUrls.length
              });
            }
          }
        } else {
          // Extract media info from the mention tweet itself (original behavior)
          const mediaKeys = tweet.attachments?.media_keys || [];
          const mediaObjects = searchResults.includes?.media?.filter(
            media => mediaKeys.includes(media.media_key!)
          ) || [];
          
          imageUrls = mediaObjects
            .filter(media => media.type === 'photo')
            .map(media => media.url!)
            .filter(url => url);
        }

        console.log('Found mention:', {
          tweetId,
          author: authorUsername,
          isReply,
          imageCount: imageUrls.length,
          text: tweet.text?.substring(0, 100) + '...'
        });

        // Create parsed tweet data similar to webhook format
        const parsedTweet: ParsedTweetData = {
          tweetId,
          username: authorUsername,
          text: tweet.text || '',
          imageUrls,
          mentionedUsers: [botUsername],
          isMentioningBot: true
        };

        // Process images if found
        if (imageUrls.length > 0) {
          for (const imageUrl of imageUrls) {
            const processingTask = processImageAndStore(imageUrl, parsedTweet, env).catch(error => {
              console.error(`Image processing failed for tweet ${tweetId}:`, error);
            });
            backgroundTasks.push(processingTask);
          }
        } else {
          if (isReply) {
            console.log(`No images found in original tweet that was replied to (reply tweet ID: ${tweetId})`);
          } else {
            console.log(`No images found in tweet ${tweetId}`);
          }
          // TODO: Could reply saying no images found
        }

      } catch (tweetError) {
        console.error('Error processing individual mention:', tweetError);
      }
    }

    // Handle background tasks
    if (backgroundTasks.length > 0) {
      console.log(`Processing ${backgroundTasks.length} images in background`);
      ctx.waitUntil(Promise.all(backgroundTasks));
    }

    console.log('Twitter polling completed successfully');

  } catch (error) {
    console.error('Error in Twitter mention polling:', error);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      
      // Apply Basic Auth to API endpoints (but not webhook endpoints)
      if (url.pathname.startsWith('/api/')) {
        const authResponse = requireBasicAuth(request, env);
        if (authResponse) {
          return authResponse; // Authentication failed
        }
      }
      
      // Handle different routes
      switch (url.pathname) {
        case '/webhook':
        case '/webhook/twitter':
          return handleTwitterWebhook(request, env, _ctx);
        
        case '/api/detections':
          return handleAPIRequest(request, env);
          
        case '/api/test-db':
          return handleDatabaseTest(request, env);
          
        default:
          return new Response('Truthscan Twitter Bot API\nEndpoints:\n- GET/POST /webhook/twitter (Twitter webhook)\n- GET /api/detections (Dashboard API, protected)\n- GET /api/test-db (Database test, protected)', { 
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
          });
      }
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron trigger fired:', {
      timestamp: new Date().toISOString(),
      scheduledTime: new Date(event.scheduledTime).toISOString(),
      cron: event.cron
    });

    try {
      // Run Twitter mention polling
      await pollTwitterMentions(env, ctx);
    } catch (error) {
      console.error('Error in scheduled Twitter polling:', error);
    }
  },
};

/**
 * Handle Twitter webhook requests (CRC validation and tweet events)
 */
async function handleTwitterWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    
    console.log('Twitter webhook request received:', {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      timestamp: new Date().toISOString()
    });
    
    // Handle Twitter's CRC (Challenge Response Check) for webhook verification
    if (request.method === 'GET') {
      return handleCRCChallenge(url, env);
    }
    
    // Handle incoming webhook events (POST)
    if (request.method === 'POST') {
      return handleTwitterEvent(request, env, ctx);
    }
    
    return new Response('Method not allowed', { status: 405 });
    
  } catch (error) {
    console.error('Error in Twitter webhook handler:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Handle Twitter CRC Challenge for webhook validation
 * Implements HMAC-SHA256 signature verification as required by Twitter
 */
async function handleCRCChallenge(url: URL, env: Env): Promise<Response> {
  try {
    // Extract crc_token from query parameters
    const crcToken = url.searchParams.get('crc_token');
    
    if (!crcToken) {
      console.error('CRC validation failed: Missing crc_token parameter');
      return new Response('Bad Request: Missing crc_token parameter', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    // Verify that Twitter consumer secret is available
    if (!env.TWITTER_API_KEY_SECRET) {
      console.error('CRC validation failed: Missing TWITTER_API_KEY_SECRET');
      return new Response('Internal Server Error: Missing consumer secret configuration', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    console.log('Processing CRC challenge for token:', crcToken.substring(0, 8) + '...');
    
    // Prepare data for HMAC signing
    const encoder = new TextEncoder();
    const keyData = encoder.encode(env.TWITTER_API_KEY_SECRET);
    const messageData = encoder.encode(crcToken);
    
    // Import the consumer secret as a CryptoKey for HMAC
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    // Generate HMAC-SHA256 signature
    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      messageData
    );
    
    // Convert signature to base64
    const signatureArray = new Uint8Array(signature);
    const base64Signature = btoa(String.fromCharCode(...signatureArray));
    
    // Format response according to Twitter's requirements
    const responseToken = `sha256=${base64Signature}`;
    const responseBody = { response_token: responseToken };
    
    console.log('CRC challenge successful, responding with signature');
    
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
    
  } catch (error) {
    console.error('CRC validation error:', error);
    return new Response('Internal Server Error during CRC validation', { 
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Twitter API Types
 */
interface TwitterWebhookPayload {
  for_user_id?: string;
  tweet_create_events?: TwitterTweet[];
}

interface TwitterTweet {
  id_str: string;
  text: string;
  user: {
    id_str: string;
    screen_name: string;
  };
  entities?: {
    user_mentions?: Array<{
      screen_name: string;
      id_str: string;
    }>;
    media?: TwitterMedia[];
  };
  extended_entities?: {
    media?: TwitterMedia[];
  };
  in_reply_to_screen_name?: string;
}

interface TwitterMedia {
  id: number;
  media_url_https: string;
  type: string;
}

interface ParsedTweetData {
  tweetId: string;
  username: string;
  text: string;
  imageUrls: string[];
  mentionedUsers: string[];
  isMentioningBot: boolean;
}

/**
 * Twitter API v2 Types for Direct API Calls
 */
interface TwitterV2SearchResponse {
  data?: Array<{
    id: string;
    text: string;
    author_id: string;
    created_at?: string;
    attachments?: {
      media_keys: string[];
    };
    referenced_tweets?: Array<{
      type: string;
      id: string;
    }>;
  }>;
  includes?: {
    users?: Array<{
      id: string;
      username: string;
    }>;
    media?: Array<{
      media_key: string;
      type: string;
      url?: string;
    }>;
    tweets?: Array<{
      id: string;
      text: string;
      author_id: string;
      attachments?: {
        media_keys: string[];
      };
    }>;
  };
}

interface TwitterV2TweetResponse {
  data: {
    id: string;
    text: string;
  };
}

/**
 * AI Detection API Types (Undetectable.AI)
 */
interface PresignedUrlResponse {
  status: string;
  presigned_url: string;
  file_path: string;
}

interface DetectionSubmissionResponse {
  id: string;
  status: string;
}

interface DetectionResultResponse {
  id: string;
  status: 'pending' | 'done' | 'failed';
  result?: number;
  result_details?: {
    detection_step: number;
    final_result: string;
    metadata: string[];
    ocr: [string, number];
    ml_model: [string, number];
    confidence: number;
  };
}

interface DetectionResult {
  success: boolean;
  aiProbability: number;
  finalResult: string;
  confidence: number;
  processingTimeMs: number;
  error?: string;
}

/**
 * Handle incoming Twitter webhook events (tweet mentions, etc.)
 */
async function handleTwitterEvent(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    // Parse the webhook payload
    const payload: TwitterWebhookPayload = await request.json();
    
    console.log('Received Twitter webhook event:', {
      timestamp: new Date().toISOString(),
      hasPayload: !!payload,
      payloadKeys: payload ? Object.keys(payload) : [],
      forUserId: payload.for_user_id,
      tweetCreateEventsCount: payload.tweet_create_events?.length || 0
    });
    
    // Check if payload contains tweet create events
    if (!payload.tweet_create_events || payload.tweet_create_events.length === 0) {
      console.log('No tweet_create_events found in payload, ignoring');
      return new Response('Event processed - no tweets', { 
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    // Process each tweet in the payload
    const processedTweets: ParsedTweetData[] = [];
    const backgroundTasks: Promise<void>[] = [];
    
    for (const tweet of payload.tweet_create_events) {
      try {
        const parsedTweet = parseTweetData(tweet, env);
        
        if (parsedTweet.isMentioningBot) {
          console.log('Bot mentioned in tweet:', {
            tweetId: parsedTweet.tweetId,
            username: parsedTweet.username,
            imageCount: parsedTweet.imageUrls.length,
            text: parsedTweet.text.substring(0, 100) + '...'
          });
          
          processedTweets.push(parsedTweet);
          
          // Process images with AI detection if present
          if (parsedTweet.imageUrls.length > 0) {
            console.log(`Processing ${parsedTweet.imageUrls.length} image(s) for AI detection...`);
            
            // For testing: await the first image to see full flow, background for rest
            let isFirstImage = true;
            
            for (const imageUrl of parsedTweet.imageUrls) {
              const imageProcessingTask = processImageAndStore(imageUrl, parsedTweet, env).catch(error => {
                console.error('Image processing failed:', error);
              });
              
              if (isFirstImage) {
                // For testing: await the first image to see the complete flow in logs
                console.log('DEBUG: Awaiting first image for testing...');
                await imageProcessingTask;
                isFirstImage = false;
              } else {
                // Handle additional images in background with proper waitUntil
                backgroundTasks.push(imageProcessingTask);
              }
            }
          } else {
            console.log('No images found in tweet, skipping AI detection');
            // TODO: In Task 6, we might want to reply with a message saying no images were found
          }
        } else {
          console.log('Tweet does not mention bot, ignoring:', {
            tweetId: parsedTweet.tweetId,
            username: parsedTweet.username
          });
        }
        
      } catch (tweetError) {
        console.error('Error processing individual tweet:', tweetError);
        // Continue processing other tweets even if one fails
      }
    }
    
    // Use waitUntil for proper background task handling
    if (backgroundTasks.length > 0 && ctx) {
      console.log(`Using waitUntil for ${backgroundTasks.length} background image processing tasks`);
      ctx.waitUntil(Promise.all(backgroundTasks));
    }
    
    console.log(`Processed ${processedTweets.length} relevant tweets out of ${payload.tweet_create_events.length} total`);
    
    return new Response('Events processed successfully', { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
    
  } catch (error) {
    console.error('Error processing Twitter webhook event:', error);
    
    // Still return 200 to avoid Twitter retrying the webhook
    // (we log the error for debugging but don't want Twitter to think our endpoint is down)
    return new Response('Event processed', { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Parse tweet data and extract relevant information
 */
function parseTweetData(tweet: TwitterTweet, env: Env): ParsedTweetData {
  // Bot's Twitter handle (from environment variable, fallback to default)
  const BOT_USERNAME = env.TWITTER_BOT_USERNAME || 'truth_scan';
  
  // Extract basic tweet information
  const tweetId = tweet.id_str;
  const username = tweet.user.screen_name;
  const text = tweet.text;
  
  // Extract mentioned users
  const mentionedUsers = tweet.entities?.user_mentions?.map(mention => mention.screen_name) || [];
  
  // Check if bot is mentioned by looking for our specific username
  const isMentioningBot = mentionedUsers.some(mentionedUser => 
    mentionedUser.toLowerCase() === BOT_USERNAME.toLowerCase()
  );
  
  // Extract image URLs from media entities
  const imageUrls = extractImageUrls(tweet);
  
  console.log('Parsed tweet data:', {
    tweetId,
    username,
    imageCount: imageUrls.length,
    mentionCount: mentionedUsers.length,
    mentionedUsers,
    isMentioningBot,
    botUsername: BOT_USERNAME,
    textPreview: text.substring(0, 50) + '...'
  });
  
  return {
    tweetId,
    username,
    text,
    imageUrls,
    mentionedUsers,
    isMentioningBot
  };
}

/**
 * Extract image URLs from Twitter media entities
 */
function extractImageUrls(tweet: TwitterTweet): string[] {
  try {
    // Prefer extended_entities.media over entities.media for complete media info
    const mediaEntities = tweet.extended_entities?.media || tweet.entities?.media || [];
    
    // Filter for photo type media and extract HTTPS URLs
    const imageUrls = mediaEntities
      .filter(media => media.type === 'photo')
      .map(media => media.media_url_https)
      .filter(url => url); // Remove any undefined/null URLs
    
    console.log('Extracted media info:', {
      totalMediaEntities: mediaEntities.length,
      photoEntities: imageUrls.length,
      mediaTypes: mediaEntities.map(m => m.type),
      imageUrls
    });
    
    return imageUrls;
    
  } catch (error) {
    console.error('Error extracting image URLs:', error);
    return [];
  }
}

/**
 * AI Detection API Functions (Undetectable.AI)
 */

// Download image from Twitter URL
async function downloadImageFromUrl(imageUrl: string): Promise<{ success: boolean; blob?: Blob; contentType?: string; filename?: string; error?: string }> {
  try {
    console.log('Downloading image:', imageUrl);
    
    // Create timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        console.log('DEBUG: Image download timed out after 5 seconds');
        reject(new Error('Download timeout'));
      }, 5000); // Reduced to 5 seconds for faster testing
    });
    
    // Create fetch promise
    const fetchPromise = fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TruthscanBot/1.0)',
        'Accept': 'image/*'
      }
    });
    
    console.log('DEBUG: Racing fetch vs timeout...');
    
    // Race fetch against timeout
    const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;
    
    console.log('DEBUG: Image download response received:', response.status, response.statusText);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    console.log('DEBUG: Getting blob from response...');
    const blob = await response.blob();
    const contentType = response.headers.get('Content-Type') || 'image/jpeg';
    
    // Extract filename from URL or create one
    const urlParts = imageUrl.split('/');
    const urlFilename = urlParts[urlParts.length - 1] || 'image.jpg';
    let filename = urlFilename.split('?')[0] || 'image.jpg'; // Remove query params
    
    // Add proper file extension based on content type if missing
    if (!filename.includes('.')) {
      if (contentType.includes('jpeg') || contentType.includes('jpg')) {
        filename += '.jpg';
      } else if (contentType.includes('png')) {
        filename += '.png';
      } else {
        filename += '.jpg'; // Default to jpg
      }
    }
    
    console.log('DEBUG: Image downloaded successfully:', {
      size: blob.size,
      type: contentType,
      filename: filename
    });
    
    return {
      success: true,
      blob,
      contentType,
      filename
    };
    
  } catch (error) {
    console.error('DEBUG: Image download failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error downloading image'
    };
  }
}

// Step 1: Get presigned URL
async function getPresignedUrl(filename: string, env: Env): Promise<{ success: boolean; data?: PresignedUrlResponse; error?: string }> {
  try {
    // Debug: Check if API key is available
    console.log('DEBUG: Checking API key availability:', !!env.AI_DETECTION_API_KEY);
    console.log('DEBUG: API key first 10 characters:', env.AI_DETECTION_API_KEY?.substring(0, 10) + '...');
    
    const cleanFilename = filename.replace(/\s+/g, '_'); // Remove spaces as required
    const url = `https://ai-image-detect.undetectable.ai/get-presigned-url?file_name=${encodeURIComponent(cleanFilename)}`;
    
    console.log('Getting presigned URL for:', cleanFilename);
    console.log('DEBUG: Making request to:', url);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': env.AI_DETECTION_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('DEBUG: Presigned URL response status:', response.status);
    console.log('DEBUG: Presigned URL response ok:', response.ok);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log('DEBUG: Error response body:', errorText);
      throw new Error(`Presigned URL request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const data: PresignedUrlResponse = await response.json();
    console.log('Presigned URL obtained successfully');
    console.log('DEBUG: Presigned URL data:', { status: data.status, hasPresignedUrl: !!data.presigned_url, filePath: data.file_path });
    
    return { success: true, data };
  } catch (error) {
    console.error('Error getting presigned URL:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown presigned URL error'
    };
  }
}

// Step 2: Upload image to presigned URL
async function uploadImageToPresignedUrl(presignedUrl: string, blob: Blob, contentType: string): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('Uploading image to presigned URL...');
    
    const response = await fetch(presignedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-amz-acl': 'private'
      },
      body: blob
    });
    
    if (!response.ok) {
      throw new Error(`Image upload failed: ${response.status} ${response.statusText}`);
    }
    
    console.log('Image uploaded successfully to presigned URL');
    return { success: true };
  } catch (error) {
    console.error('Error uploading image:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown upload error'
    };
  }
}

// Step 3: Submit image for detection
async function submitImageForDetection(filePath: string, env: Env): Promise<{ success: boolean; data?: DetectionSubmissionResponse; error?: string }> {
  try {
    console.log('Submitting image for detection:', filePath);
    
    const response = await fetch('https://ai-image-detect.undetectable.ai/detect', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key: env.AI_DETECTION_API_KEY,
        url: `https://ai-image-detector-prod.nyc3.digitaloceanspaces.com/${filePath}`
      })
    });
    
    if (!response.ok) {
      throw new Error(`Detection submission failed: ${response.status} ${response.statusText}`);
    }
    
    const data: DetectionSubmissionResponse = await response.json();
    console.log('Detection submitted successfully:', data.id);
    
    return { success: true, data };
  } catch (error) {
    console.error('Error submitting for detection:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown submission error'
    };
  }
}

// Step 4: Query detection results (with polling)
async function queryDetectionResults(detectionId: string, maxAttempts = 12, delayMs = 5000): Promise<{ success: boolean; data?: DetectionResultResponse; error?: string }> {
  try {
    console.log('Querying detection results for ID:', detectionId);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch('https://ai-image-detect.undetectable.ai/query', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: detectionId
        })
      });
      
      if (!response.ok) {
        throw new Error(`Detection query failed: ${response.status} ${response.statusText}`);
      }
      
      const data: DetectionResultResponse = await response.json();
      console.log(`Detection query attempt ${attempt}:`, { status: data.status, id: detectionId });
      
      if (data.status === 'done') {
        console.log('Detection completed successfully');
        return { success: true, data };
      } else if (data.status === 'failed') {
        throw new Error('Detection processing failed');
      }
      
      // Status is still 'pending', wait before next attempt
      if (attempt < maxAttempts) {
        console.log(`Detection still pending, waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    throw new Error(`Detection timed out after ${maxAttempts} attempts`);
  } catch (error) {
    console.error('Error querying detection results:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown query error'
    };
  }
}

// Main function: Process image with AI detection
async function processImageWithAI(imageUrl: string, env: Env): Promise<DetectionResult> {
  const startTime = Date.now();
  
  try {
    console.log('Starting AI detection process for:', imageUrl);
    console.log('DEBUG: API key available in env:', !!env.AI_DETECTION_API_KEY);
    
    // Step 1: Download image from Twitter
    console.log('DEBUG: Step 1 - Starting image download...');
    const downloadResult = await downloadImageFromUrl(imageUrl);
    console.log('DEBUG: Download result:', { success: downloadResult.success, error: downloadResult.error });
    
    if (!downloadResult.success || !downloadResult.blob || !downloadResult.filename) {
      throw new Error(downloadResult.error || 'Failed to download image');
    }
    
    console.log('DEBUG: Step 2 - Getting presigned URL...');
    // Step 2: Get presigned URL
    const presignedResult = await getPresignedUrl(downloadResult.filename, env);
    console.log('DEBUG: Presigned result:', { success: presignedResult.success, error: presignedResult.error });
    
    if (!presignedResult.success || !presignedResult.data) {
      throw new Error(presignedResult.error || 'Failed to get presigned URL');
    }
    
    console.log('DEBUG: Step 3 - Uploading image...');
    // Step 3: Upload image
    const uploadResult = await uploadImageToPresignedUrl(
      presignedResult.data.presigned_url,
      downloadResult.blob,
      downloadResult.contentType || 'image/jpeg'
    );
    console.log('DEBUG: Upload result:', { success: uploadResult.success, error: uploadResult.error });
    
    if (!uploadResult.success) {
      throw new Error(uploadResult.error || 'Failed to upload image');
    }
    
    console.log('DEBUG: Step 4 - Submitting for detection...');
    // Step 4: Submit for detection
    const submissionResult = await submitImageForDetection(presignedResult.data.file_path, env);
    console.log('DEBUG: Submission result:', { success: submissionResult.success, error: submissionResult.error });
    
    if (!submissionResult.success || !submissionResult.data) {
      throw new Error(submissionResult.error || 'Failed to submit for detection');
    }
    
    console.log('DEBUG: Step 5 - Querying results...');
    // Step 5: Query results
    const queryResult = await queryDetectionResults(submissionResult.data.id);
    console.log('DEBUG: Query result:', { success: queryResult.success, error: queryResult.error });
    
    if (!queryResult.success || !queryResult.data) {
      throw new Error(queryResult.error || 'Failed to get detection results');
    }
    
    const processingTime = Date.now() - startTime;
    
    // Extract results
    const result = queryResult.data.result || 0;
    const finalResult = queryResult.data.result_details?.final_result || 'Unknown';
    const confidence = queryResult.data.result_details?.confidence || result;
    
    console.log('AI detection completed successfully:', {
      aiProbability: result,
      finalResult,
      confidence,
      processingTimeMs: processingTime
    });
    
    return {
      success: true,
      aiProbability: result,
      finalResult,
      confidence,
      processingTimeMs: processingTime
    };
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('AI detection process failed:', error);
    console.error('DEBUG: Full error details:', error instanceof Error ? error.stack : error);
    
    return {
      success: false,
      aiProbability: 0,
      finalResult: 'Error',
      confidence: 0,
      processingTimeMs: processingTime,
      error: error instanceof Error ? error.message : 'Unknown detection error'
    };
  }
}

/**
 * Twitter API Functions for Replies
 */

/**
 * Generate OAuth 1.0a signature for Twitter API v2
 */
async function generateTwitterOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  env: Env
): Promise<string> {
  // OAuth parameters
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: env.TWITTER_API_KEY,
    oauth_token: env.TWITTER_ACCESS_TOKEN,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_version: '1.0'
  };

  // Combine all parameters
  const allParams: Record<string, string> = { ...params, ...oauthParams };
  
  // Create parameter string
  const paramString = Object.keys(allParams)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(allParams[key])}`)
    .join('&');

  // Create base string
  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  
  // Create signing key
  const signingKey = `${encodeURIComponent(env.TWITTER_API_KEY_SECRET)}&${encodeURIComponent(env.TWITTER_ACCESS_TOKEN_SECRET)}`;
  
  // Generate signature
  const encoder = new TextEncoder();
  const keyData = encoder.encode(signingKey);
  const messageData = encoder.encode(baseString);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const signatureArray = new Uint8Array(signature);
  const base64Signature = btoa(String.fromCharCode(...signatureArray));
  
  // Build authorization header
  const authParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: base64Signature
  };
  
  const authHeader = 'OAuth ' + Object.keys(authParams)
    .sort()
    .map(key => `${encodeURIComponent(key)}="${encodeURIComponent(authParams[key])}"`)
    .join(', ');
    
  return authHeader;
}

/**
 * Compose reply message based on AI detection score
 */
function composeReplyMessage(aiProbability: number, _finalResult: string): string {
  // The API returns confidence as a percentage (0-100), format to 2 decimal places
  const percentage = parseFloat(aiProbability.toFixed(2));
  
  // Create base message with probability
  let message = `🧠 This image looks ${percentage}% likely to be AI-generated.`;
  
  // Add context based on confidence level
  if (percentage >= 80) {
    message += ' 🤖 High confidence: Likely AI';
  } else if (percentage >= 60) {
    message += ' 🤔 Moderate confidence';
  } else if (percentage >= 40) {
    message += ' 📸 Leaning towards human-made';
  } else {
    message += ' 👨‍🎨 Likely human-created';
  }
  
  // Add hashtags for discovery
  message += ' #AIDetection #TruthScan';
  
  return message;
}

/**
 * Post reply to original tweet with AI detection results using direct API calls
 */
async function replyToTweet(
  originalTweetId: string, 
  aiProbability: number, 
  finalResult: string, 
  env: Env
): Promise<{ success: boolean; replyTweetId?: string; error?: string }> {
  try {
    console.log('Preparing to reply to tweet:', {
      originalTweetId,
      aiProbability: aiProbability + '%',
      finalResult
    });
    
    // Compose reply message
    const replyMessage = composeReplyMessage(aiProbability, finalResult);
    
    console.log('Sending reply:', {
      message: replyMessage,
      originalTweetId
    });
    
    // Prepare tweet data
    const tweetData = {
      text: replyMessage,
      reply: {
        in_reply_to_tweet_id: originalTweetId
      }
    };
    
    // Generate OAuth signature for POST request
    const url = 'https://api.twitter.com/2/tweets';
    const authHeader = await generateTwitterOAuthSignature('POST', url, {}, env);
    
    // Post the reply using Twitter API v2
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tweetData)
    });
    
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Twitter API error: ${response.status} ${response.statusText} - ${errorData}`);
    }
    
    const replyResponse: TwitterV2TweetResponse = await response.json();
    
    console.log('Reply posted successfully:', {
      replyTweetId: replyResponse.data.id,
      text: replyResponse.data.text
    });
    
    return {
      success: true,
      replyTweetId: replyResponse.data.id
    };
    
  } catch (error: any) {
    console.error('Failed to reply to tweet:', {
      originalTweetId,
      error: error?.message || error
    });
    
    // Handle specific Twitter API errors
    let errorMessage = 'Unknown error';
    
    if (error?.message?.includes('429')) {
      errorMessage = 'Rate limit exceeded';
    } else if (error?.message?.includes('403')) {
      errorMessage = 'Permission denied - check API credentials and permissions';
    } else if (error?.message?.includes('400')) {
      errorMessage = 'Bad request - invalid tweet ID or message format';
    } else if (error?.message) {
      errorMessage = error.message;
    }
    
    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Main processing function: Process image and handle tweet reply
 */
async function processImageAndStore(imageUrl: string, tweetData: ParsedTweetData, env: Env): Promise<void> {
  const detectionId = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  
  try {
    console.log('Starting image processing and storage:', { imageUrl, tweetId: tweetData.tweetId });
    
    // Run AI detection
    const detectionResult = await processImageWithAI(imageUrl, env);
    
    let responseTweetId: string | undefined;
    
    // If AI detection was successful, reply to the original tweet
    if (detectionResult.success) {
      console.log('AI detection successful, attempting to reply to tweet...');
      
      try {
        const replyResult = await replyToTweet(
          tweetData.tweetId,
          detectionResult.aiProbability,
          detectionResult.finalResult,
          env
        );
        
        if (replyResult.success) {
          responseTweetId = replyResult.replyTweetId;
          console.log('Successfully replied to tweet:', {
            originalTweetId: tweetData.tweetId,
            replyTweetId: responseTweetId
          });
        } else {
          console.error('Failed to reply to tweet:', replyResult.error);
          // Continue with database storage even if reply fails
        }
      } catch (replyError) {
        console.error('Error attempting to reply to tweet:', replyError);
        // Continue with database storage even if reply fails
      }
    } else {
      console.log('AI detection failed, skipping tweet reply:', detectionResult.error);
    }
    
    // Store result in database (including reply tweet ID if available)
    const insertSuccess = await insertDetection(env, {
      id: detectionId,
      tweetId: tweetData.tweetId,
      timestamp,
      imageUrl,
      detectionScore: detectionResult.success ? detectionResult.aiProbability : undefined,
      twitterHandle: tweetData.username,
      responseTweetId: responseTweetId,
      processingTimeMs: detectionResult.processingTimeMs,
      apiProvider: 'undetectable.ai'
    });
    
    if (insertSuccess) {
      console.log('Image processing completed and stored:', {
        detectionId,
        tweetId: tweetData.tweetId,
        imageUrl,
        aiProbability: detectionResult.aiProbability,
        responseTweetId: responseTweetId,
        success: detectionResult.success
      });
    } else {
      console.error('Failed to store detection result in database');
    }
    
  } catch (error) {
    console.error('Error in processImageAndStore:', error);
    
    // Still try to store the error result
    await insertDetection(env, {
      id: detectionId,
      tweetId: tweetData.tweetId,
      timestamp,
      imageUrl,
      detectionScore: undefined,
      twitterHandle: tweetData.username,
      processingTimeMs: 0,
      apiProvider: 'undetectable.ai'
    }).catch(dbError => {
      console.error('Failed to store error result:', dbError);
    });
  }
}

/**
 * Database Operations
 */

// Test D1 database connectivity
async function testDatabaseConnection(env: Env): Promise<boolean> {
  try {
    const result = await env.DB.prepare('SELECT 1 as test').first();
    console.log('Database connection test:', result);
    return result?.test === 1;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

// Insert a new detection result (will be used in Task 5)
async function insertDetection(env: Env, data: {
  id: string;
  tweetId: string;
  timestamp: number;
  imageUrl: string;
  detectionScore?: number;
  twitterHandle: string;
  responseTweetId?: string;
  processingTimeMs?: number;
  apiProvider?: string;
}): Promise<boolean> {
  try {
    const stmt = env.DB.prepare(`
      INSERT INTO detections (
        id, tweet_id, timestamp, image_url, detection_score, 
        twitter_handle, response_tweet_id, processing_time_ms, api_provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = await stmt.bind(
      data.id,
      data.tweetId,
      data.timestamp,
      data.imageUrl,
      data.detectionScore || null,
      data.twitterHandle,
      data.responseTweetId || null,
      data.processingTimeMs || null,
      data.apiProvider || null
    ).run();
    
    console.log('Detection inserted:', { id: data.id, success: result.success });
    return result.success;
  } catch (error) {
    console.error('Failed to insert detection:', error);
    return false;
  }
}

// Get recent detections for dashboard
async function getRecentDetections(env: Env, limit = 50): Promise<any[]> {
  try {
    const stmt = env.DB.prepare(`
      SELECT id, tweet_id, timestamp, image_url, detection_score, 
             twitter_handle, response_tweet_id, processing_time_ms, api_provider,
             created_at
      FROM detections 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    
    const result = await stmt.bind(limit).all();
    return result.results || [];
  } catch (error) {
    console.error('Failed to get recent detections:', error);
    return [];
  }
}

/**
 * Handle API requests for the dashboard
 */
async function handleAPIRequest(request: Request, env: Env): Promise<Response> {
  // Add CORS headers for dashboard
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  if (request.method === 'GET') {
    try {
      // Fetch detection results from D1 database
      const detections = await getRecentDetections(env, 100);
      
      // Transform data for dashboard compatibility
      const transformedData = detections.map(detection => ({
        id: detection.id,
        tweetId: detection.tweet_id,
        username: detection.twitter_handle,
        imageUrl: detection.image_url,
        aiProbability: detection.detection_score,
        timestamp: new Date(detection.timestamp * 1000).toISOString(),
        processingTime: detection.processing_time_ms,
        apiProvider: detection.api_provider,
        responseTweetId: detection.response_tweet_id
      }));
      
      return new Response(JSON.stringify(transformedData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('API request failed:', error);
      return new Response(JSON.stringify({ error: 'Failed to fetch detections' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  return new Response('Method not allowed', { 
    status: 405,
    headers: corsHeaders
  });
}

/**
 * Handle database connectivity test requests
 */
async function handleDatabaseTest(request: Request, env: Env): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  if (request.method === 'GET') {
    try {
      const isConnected = await testDatabaseConnection(env);
      const detections = await getRecentDetections(env, 5);
      
      const testResult = {
        connected: isConnected,
        timestamp: new Date().toISOString(),
        recordCount: detections.length,
        sampleRecords: detections,
        databaseTables: isConnected ? ['detections', 'webhook_logs'] : []
      };
      
      return new Response(JSON.stringify(testResult), {
        status: isConnected ? 200 : 503,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('Database test failed:', error);
      return new Response(JSON.stringify({
        connected: false,
        error: 'Database test failed',
        timestamp: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  return new Response('Method not allowed', { 
    status: 405,
    headers: corsHeaders
  });
} 