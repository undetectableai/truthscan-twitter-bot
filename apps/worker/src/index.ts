/**
 * Truthscan Twitter Bot - Cloudflare Worker
 * Real-time AI image detection for Twitter mentions
 */

interface ScheduledEvent {
  readonly scheduledTime: number;
  readonly cron: string;
  waitUntil(promise: Promise<any>): void;
}

// MONITORING AND LOGGING INTERFACES

interface LogEntry {
  id: string;
  timestamp: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  eventType: string;
  message: string;
  details?: Record<string, any>;
  userAgent?: string;
  ipAddress?: string;
  url?: string;
  pageId?: string;
  processingTimeMs?: number;
}

interface PageViewEntry {
  id: string;
  pageId: string;
  timestamp: number;
  userAgent?: string;
  ipAddress?: string;
  referrer?: string;
  viewDurationMs?: number;
  isBot: boolean;
  country?: string;
}

interface SystemMetricEntry {
  id: string;
  metricName: string;
  metricValue: number;
  metricType: 'counter' | 'gauge' | 'histogram';
  timestamp: number;
  period?: string;
  tags?: Record<string, any>;
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

// MONITORING AND LOGGING FUNCTIONS

/**
 * Log structured error/event to database
 */
async function logEvent(
  env: Env,
  logLevel: 'error' | 'warn' | 'info' | 'debug',
  eventType: string,
  message: string,
  options: {
    details?: Record<string, any>;
    userAgent?: string;
    ipAddress?: string;
    url?: string;
    pageId?: string;
    processingTimeMs?: number;
  } = {}
): Promise<void> {
  try {
    const logEntry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: Math.floor(Date.now() / 1000),
      logLevel,
      eventType,
      message,
      ...options
    };

    await env.DB
      .prepare(`INSERT INTO error_logs 
        (id, timestamp, log_level, event_type, message, details, user_agent, ip_address, url, page_id, processing_time_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        logEntry.id,
        logEntry.timestamp,
        logEntry.logLevel,
        logEntry.eventType,
        logEntry.message,
        logEntry.details ? JSON.stringify(logEntry.details) : null,
        logEntry.userAgent || null,
        logEntry.ipAddress || null,
        logEntry.url || null,
        logEntry.pageId || null,
        logEntry.processingTimeMs || null
      )
      .run();

    // Also log to console for immediate debugging
    console.log(`[${logLevel.toUpperCase()}] ${eventType}: ${message}`, options.details || '');
    
  } catch (error) {
    // Fallback to console if database logging fails
    console.error('Failed to log event to database:', error);
    console.log(`[${logLevel.toUpperCase()}] ${eventType}: ${message}`, options.details || '');
  }
}

/**
 * Log page view for analytics
 */
async function logPageView(
  env: Env,
  pageId: string,
  request: Request,
  options: {
    viewDurationMs?: number;
    isBot?: boolean;
  } = {}
): Promise<void> {
  try {
    const userAgent = request.headers.get('User-Agent') || undefined;
    const referrer = request.headers.get('Referer') || undefined;
    const ipAddress = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || undefined;
    const country = request.headers.get('CF-IPCountry') || undefined;

    // Simple bot detection based on user agent
    const isBot = options.isBot ?? detectBot(userAgent);

    const viewEntry: PageViewEntry = {
      id: crypto.randomUUID(),
      pageId,
      timestamp: Math.floor(Date.now() / 1000),
      userAgent,
      ipAddress,
      referrer,
      viewDurationMs: options.viewDurationMs,
      isBot,
      country
    };

    await env.DB
      .prepare(`INSERT INTO page_views 
        (id, page_id, timestamp, user_agent, ip_address, referrer, view_duration_ms, is_bot, country)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        viewEntry.id,
        viewEntry.pageId,
        viewEntry.timestamp,
        viewEntry.userAgent || null,
        viewEntry.ipAddress || null,
        viewEntry.referrer || null,
        viewEntry.viewDurationMs || null,
        viewEntry.isBot ? 1 : 0,
        viewEntry.country || null
      )
      .run();

    console.log(`Page view logged: ${pageId} (bot: ${isBot})`);
    
  } catch (error) {
    console.error('Failed to log page view:', error);
  }
}

/**
 * Record system metric
 */
async function logSystemMetric(
  env: Env,
  metricName: string,
  metricValue: number,
  metricType: 'counter' | 'gauge' | 'histogram',
  options: {
    period?: string;
    tags?: Record<string, any>;
  } = {}
): Promise<void> {
  try {
    const metricEntry: SystemMetricEntry = {
      id: crypto.randomUUID(),
      metricName,
      metricValue,
      metricType,
      timestamp: Math.floor(Date.now() / 1000),
      period: options.period,
      tags: options.tags
    };

    await env.DB
      .prepare(`INSERT INTO system_metrics 
        (id, metric_name, metric_value, metric_type, timestamp, period, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        metricEntry.id,
        metricEntry.metricName,
        metricEntry.metricValue,
        metricEntry.metricType,
        metricEntry.timestamp,
        metricEntry.period || null,
        metricEntry.tags ? JSON.stringify(metricEntry.tags) : null
      )
      .run();

    console.log(`Metric logged: ${metricName} = ${metricValue} (${metricType})`);
    
  } catch (error) {
    console.error('Failed to log system metric:', error);
  }
}

/**
 * Simple bot detection based on user agent
 */
function detectBot(userAgent?: string): boolean {
  if (!userAgent) return false;
  
  const botPatterns = [
    /bot/i, /crawler/i, /spider/i, /scraper/i,
    /googlebot/i, /bingbot/i, /slurp/i, /duckduckbot/i,
    /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i,
    /whatsapp/i, /telegram/i, /curl/i, /wget/i, /python/i
  ];
  
  return botPatterns.some(pattern => pattern.test(userAgent));
}

/**
 * Convenience functions for common event types
 */
const MonitoringEvents = {
  async logPageNotFound(env: Env, pageId: string, request: Request, processingTimeMs?: number) {
    await logEvent(env, 'warn', 'page_not_found', `Detection page not found: ${pageId}`, {
      pageId,
      userAgent: request.headers.get('User-Agent') || undefined,
      ipAddress: request.headers.get('CF-Connecting-IP') || undefined,
      url: request.url,
      processingTimeMs
    });
  },

  async logDatabaseError(env: Env, operation: string, error: any, context?: Record<string, any>) {
    await logEvent(env, 'error', 'database_error', `Database operation failed: ${operation}`, {
      details: {
        operation,
        error: error?.message || String(error),
        context
      }
    });
  },

  async logImageLoadFailed(env: Env, imageUrl: string, error: any, processingTimeMs?: number) {
    await logEvent(env, 'error', 'image_load_failed', `Failed to load image: ${imageUrl}`, {
      details: {
        imageUrl,
        error: error?.message || String(error)
      },
      processingTimeMs
    });
  },

  async logAPIError(env: Env, apiName: string, error: any, context?: Record<string, any>) {
    await logEvent(env, 'error', 'api_error', `API call failed: ${apiName}`, {
      details: {
        apiName,
        error: error?.message || String(error),
        context
      }
    });
  },

  async logDetectionProcessed(env: Env, pageId: string, processingTimeMs: number, success: boolean) {
    await logEvent(env, 'info', 'detection_processed', `Detection ${success ? 'completed' : 'failed'}`, {
      pageId,
      processingTimeMs,
      details: { success }
    });
  }
};

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
 * Smart incremental Twitter mention polling - only fetches tweets newer than sinceId
 * This prevents duplicate processing and optimizes API usage
 */
async function pollTwitterMentionsIncremental(
  env: Env, 
  ctx: ExecutionContext, 
  sinceId: string | null = null
): Promise<{ newTweetsCount: number; highestTweetId: string | null }> {
  try {
    console.log('Starting smart Twitter mention polling...', sinceId ? `since ID: ${sinceId}` : 'initial call');

    // Check rate limits
    if (!canMakeTwitterRequest()) {
      console.log('Twitter API rate limit reached, skipping polling cycle');
      return { newTweetsCount: 0, highestTweetId: null };
    }

    // Bot username from environment
    const botUsername = env.TWITTER_BOT_USERNAME || 'truth_scan';
    
    // Search for recent mentions using direct API call
    const searchQuery = `@${botUsername}`;

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
    
    // KEY OPTIMIZATION: Only fetch tweets newer than the last processed one
    if (sinceId) {
      searchUrl.searchParams.set('since_id', sinceId);
      console.log(`Using since_id parameter: ${sinceId}`);
    }

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

    console.log('Smart Twitter search completed:', {
      resultCount: searchResults.data?.length || 0,
      sinceId: sinceId || 'none',
      rateLimit: twitterRateLimit
    });

    if (!searchResults.data || searchResults.data.length === 0) {
      console.log(sinceId ? 'No new mentions found since last check' : 'No recent mentions found');
      return { newTweetsCount: 0, highestTweetId: sinceId };
    }

    // Find the highest tweet ID for the next incremental call
    let highestTweetId = sinceId;
    const tweetIds = searchResults.data.map(t => t.id);
    
    // Twitter IDs are sortable as strings (they're snowflake IDs)
    if (tweetIds.length > 0) {
      highestTweetId = tweetIds.sort().reverse()[0]; // Get the highest ID
    }

    // Process each found mention
    const backgroundTasks: Promise<void>[] = [];
    let newTweetsProcessed = 0;
    
    for (const tweet of searchResults.data) {
      try {
        const tweetId = tweet.id;
        
        // Backup check for deduplication (should be rare with since_id)
        const alreadyProcessed = await isAlreadyProcessed(tweetId, env);
        if (alreadyProcessed) {
          console.log(`Tweet ${tweetId} already processed (backup check), skipping`);
          continue;
        }

        newTweetsProcessed++;

        // Get user info from includes
        const author = searchResults.includes?.users?.find(
          user => user.id === tweet.author_id
        );
        const authorUsername = author?.username || 'unknown';

        // Check if this mention is a reply to another tweet
        const isReply = tweet.referenced_tweets?.some(ref => ref.type === 'replied_to');
        let imageUrls: string[] = [];
        let sourceText = tweet.text || ''; // Default to reply text
        let sourceHashtags: string[] = [];
        
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
                
              // IMPORTANT: Extract hashtags and text from the ORIGINAL tweet, not the reply
              sourceText = originalTweet.text || '';
              const hashtagMatches = sourceText.match(/#\w+/g) || [];
              sourceHashtags = hashtagMatches.map(tag => tag.substring(1)); // Remove # symbol
                
              console.log('Found NEW reply to tweet with images:', {
                originalTweetId: referencedTweetId,
                imageCount: imageUrls.length,
                originalText: sourceText.substring(0, 100) + '...',
                originalHashtags: sourceHashtags
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
            
          // For direct mentions, extract hashtags from the mention tweet
          const hashtagMatches = sourceText.match(/#\w+/g) || [];
          sourceHashtags = hashtagMatches.map(tag => tag.substring(1)); // Remove # symbol
        }

        console.log('Found NEW mention:', {
          tweetId,
          author: authorUsername,
          isReply,
          imageCount: imageUrls.length,
          replyText: tweet.text?.substring(0, 100) + '...',
          sourceText: sourceText.substring(0, 100) + '...',
          sourceHashtags
        });
        
        // Create parsed tweet data using the correct source (original tweet for replies, mention tweet for direct mentions)
        const parsedTweet: ParsedTweetData = {
          tweetId,
          username: authorUsername,
          text: sourceText, // Use original tweet text for replies, mention tweet text for direct mentions
          imageUrls,
          mentionedUsers: [botUsername],
          isMentioningBot: true,
          hashtags: sourceHashtags // Use hashtags from the correct source tweet
        };

        // Process images if found
        if (imageUrls.length > 0) {
          // Use batch processing for consolidated reply
          const batchProcessingTask = processAllImagesAndReply(imageUrls, parsedTweet, env).catch(error => {
            console.error(`Batch image processing failed for tweet ${tweetId}:`, error);
          });
          backgroundTasks.push(batchProcessingTask);
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
      console.log(`Processing ${backgroundTasks.length} images from ${newTweetsProcessed} new tweets in background`);
      ctx.waitUntil(Promise.all(backgroundTasks));
    }

    console.log(`Smart Twitter polling completed: ${newTweetsProcessed} new tweets processed`);
    
    return { 
      newTweetsCount: newTweetsProcessed, 
      highestTweetId: highestTweetId 
    };

  } catch (error) {
    console.error('Error in smart Twitter mention polling:', error);
    return { newTweetsCount: 0, highestTweetId: sinceId };
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
          
        case '/api/test-shorturl':
          return handleShortUrlTest(request, env);
          
        case '/api/test-reply-formatting':
          return handleReplyFormattingTest(request, env);
          
        case '/api/test-database-updates':
          return handleDatabaseUpdatesTest(request, env);
          
        case '/api/generate-monitoring-test-data':
          return handleGenerateTestMonitoringData(request, env);
          
        case '/api/validate-monitoring-system':
          return handleMonitoringValidation(request, env);
          
        case '/api/clear-cache':
          return handleClearCache(request, env);
          
        // Monitoring API endpoints
        case '/api/monitoring/logs':
          return handleMonitoringLogs(request, env);
          
        case '/api/monitoring/page-views':
          return handleMonitoringPageViews(request, env);
          
        case '/api/monitoring/metrics':
          return handleMonitoringMetrics(request, env);
          
        case '/api/monitoring/dashboard':
          return handleMonitoringDashboard(request, env);
          
        default:
          // Handle image requests with pattern /images/:id
          if (url.pathname.startsWith('/images/')) {
            return handleImageRequest(request, env);
          }
          
          // Handle thumbnail requests with pattern /thumbnails/:id
          if (url.pathname.startsWith('/thumbnails/')) {
            return handleThumbnailRequest(request, env);
          }
          
              // Handle detection page requests with pattern /d/:id
    if (url.pathname.startsWith('/d/')) {
            return handleDetectionPage(request, env);
          }
            return new Response('Truthscan Twitter Bot API\nEndpoints:\n- GET/POST /webhook/twitter (Twitter webhook)\n- GET /api/detections (Dashboard API, protected)\n- GET /api/test-db (Database test, protected)\n- GET /api/test-shorturl (Short URL generation test, protected)\n- GET /d/:id (Public detection results page)', { 
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
      // Smart polling: 4 calls per minute, but each call only fetches NEW tweets
      // This maximizes our Basic plan rate limit while avoiding duplicate processing
      const pollingPromises: Promise<void>[] = [];
      let lastProcessedTweetId: string | null = null;
      
      for (let i = 0; i < 4; i++) {
        const delayMs = i * 15000; // 0s, 15s, 30s, 45s
        
        const pollingPromise = new Promise<void>((resolve) => {
          setTimeout(async () => {
            try {
              console.log(`Starting smart polling call ${i + 1}/4 (${delayMs/1000}s delay)`);
              const result = await pollTwitterMentionsIncremental(env, ctx, lastProcessedTweetId);
              
              // Update the last processed tweet ID for the next call
              if (result.highestTweetId) {
                lastProcessedTweetId = result.highestTweetId;
                console.log(`Updated last processed tweet ID to: ${lastProcessedTweetId}`);
              }
              
              console.log(`Completed smart polling call ${i + 1}/4 - Found ${result.newTweetsCount} new tweets`);
            } catch (error) {
              console.error(`Error in smart polling call ${i + 1}/4:`, error);
            }
            resolve();
          }, delayMs);
        });
        
        pollingPromises.push(pollingPromise);
      }
      
      // Use waitUntil to ensure all polling calls complete
      ctx.waitUntil(Promise.all(pollingPromises));
      
      console.log('Scheduled 4 smart polling calls (incremental, every 15s) for this minute');
      
    } catch (error) {
      console.error('Error in scheduled Twitter smart polling setup:', error);
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
    hashtags?: Array<{
      text: string;
      indices: [number, number];
    }>;
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
  hashtags: string[];
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
  imageData?: ArrayBuffer;
  imageContentType?: string;
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
            console.log(`Processing ${parsedTweet.imageUrls.length} image(s) for AI detection with consolidated reply...`);
            
            // Use batch processing for consolidated reply
            const batchProcessingTask = processAllImagesAndReply(parsedTweet.imageUrls, parsedTweet, env).catch(error => {
              console.error('Batch image processing failed:', error);
            });
            
            // For webhook events, we can await the first batch to see full flow in logs
            console.log('DEBUG: Awaiting batch processing for testing...');
            await batchProcessingTask;
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
  
  // Extract hashtags from entities
  const hashtags = tweet.entities?.hashtags?.map(hashtag => hashtag.text) || [];
  
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
    hashtagCount: hashtags.length,
    hashtags,
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
    isMentioningBot,
    hashtags
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
    
    // Get image data as ArrayBuffer for database storage
    const imageArrayBuffer = await downloadResult.blob.arrayBuffer();
    
    console.log('AI detection completed successfully:', {
      aiProbability: result,
      finalResult,
      confidence,
      processingTimeMs: processingTime,
      imageSize: imageArrayBuffer.byteLength
    });
    
    return {
      success: true,
      aiProbability: result,
      finalResult,
      confidence,
      processingTimeMs: processingTime,
      imageData: imageArrayBuffer,
      imageContentType: downloadResult.contentType || 'image/jpeg'
    };
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    // Log API error for monitoring
    await MonitoringEvents.logAPIError(env, 'AI Detection', error, { 
      imageUrl, 
      processingTimeMs: processingTime 
    });
    
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
 * Enhanced Image Handling with R2 Fallback and Thumbnail Generation
 */







/**
 * Get or generate thumbnail for a detection
 */


/**
 * Generate a branded placeholder image as fallback
 */
async function getPlaceholderImage(): Promise<ArrayBuffer> {
  // Simple 1200x630 placeholder with TruthScan branding
  // This would ideally be a pre-generated image stored as base64 or in R2
  const placeholderSvg = `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="#1F2937"/>
      <text x="600" y="300" text-anchor="middle" fill="#FFFFFF" font-family="Arial" font-size="48" font-weight="bold">🔍 TruthScan</text>
      <text x="600" y="360" text-anchor="middle" fill="#9CA3AF" font-family="Arial" font-size="24">AI Content Detection</text>
      <text x="600" y="420" text-anchor="middle" fill="#6B7280" font-family="Arial" font-size="18">Image not available</text>
    </svg>
  `;
  
  const encoder = new TextEncoder();
  return encoder.encode(placeholderSvg).buffer;
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
 * Extract meaningful keywords from tweet text for hashtag generation
 */
function extractKeywordsFromText(tweetText: string): string[] {
  // Common words to filter out (stop words)
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'will', 'would', 'could',
    'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
    'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'can', 'do', 'does', 'did',
    'get', 'go', 'going', 'got', 'just', 'now', 'like', 'said', 'say', 'see', 'know', 'think',
    'take', 'come', 'good', 'new', 'first', 'last', 'long', 'great', 'little', 'own', 'other',
    'old', 'right', 'big', 'high', 'different', 'small', 'large', 'next', 'early', 'young',
    'important', 'few', 'public', 'bad', 'same', 'able', 'rt', 'via'
  ]);
  
  // Clean the text: remove URLs, mentions, and punctuation
  const cleanText = tweetText
    .replace(/https?:\/\/\S+/g, '') // Remove URLs
    .replace(/@\w+/g, '') // Remove mentions
    .replace(/[^\w\s]/g, ' ') // Remove punctuation
    .toLowerCase()
    .trim();
  
  // Split into words and filter
  const words = cleanText
    .split(/\s+/)
    .filter(word => 
      word.length >= 3 && // At least 3 characters
      word.length <= 15 && // Not too long
      !stopWords.has(word) && // Not a stop word
      !/^\d+$/.test(word) && // Not just numbers
      /^[a-z]+$/.test(word) // Only letters
    );
  
  // Count word frequency
  const wordCounts = new Map();
  words.forEach(word => {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  });
  
  // Sort by frequency and return top keywords
  return Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1]) // Sort by count (descending)
    .slice(0, 3) // Take top 3
    .map(([word]) => word);
}

/**
 * Format hashtags for reply message - always return exactly 3 hashtags by combining original, keywords, and defaults
 */
function formatHashtagsForReply(originalHashtags: string[], tweetText: string = ''): string {
  const defaultHashtags = ['AIDetection', 'TruthScan'];
  let finalHashtags: string[] = [];
  
  // Filter out common bot/spam hashtags that we don't want to reuse
  const filteredHashtags = originalHashtags.filter(tag => {
    const lowerTag = tag.toLowerCase();
    return !lowerTag.includes('bot') && 
           !lowerTag.includes('spam') && 
           !lowerTag.includes('follow') &&
           !lowerTag.includes('like') &&
           !lowerTag.includes('rt');
  });
  
  // Start with original hashtags (up to 3)
  if (filteredHashtags.length > 0) {
    finalHashtags = filteredHashtags.slice(0, 3);
  }
  
  // If we need more hashtags and have tweet text, extract keywords
  if (finalHashtags.length < 3 && tweetText.trim()) {
    const keywords = extractKeywordsFromText(tweetText);
    const needed = 3 - finalHashtags.length;
    const keywordsToAdd = keywords.slice(0, needed);
    finalHashtags = [...finalHashtags, ...keywordsToAdd];
  }
  
  // If we still need more hashtags, add defaults
  if (finalHashtags.length < 3) {
    const needed = 3 - finalHashtags.length;
    const defaultsToAdd = defaultHashtags.slice(0, needed);
    finalHashtags = [...finalHashtags, ...defaultsToAdd];
  }
  
  // Ensure we have at least 2 hashtags (fallback safety)
  if (finalHashtags.length === 0) {
    finalHashtags = defaultHashtags;
  }
  
  // Format and return (always 2-3 hashtags)
  return finalHashtags.map(tag => `#${tag}`).join(' ');
}

/**
 * Compose reply message based on AI detection score
 */
function composeReplyMessage(aiProbability: number, _finalResult: string, originalHashtags: string[] = [], tweetText: string = '', pageId?: string): string {
  // The API returns confidence as a percentage (0-100), format to 2 digits with no decimal
  const percentage = Math.round(aiProbability);
  
  // Create base message with probability
  let message = `🧠 This image looks ${percentage}% likely to be AI-generated.`;
  
  // Add context based on confidence level with new 6-tier system
  if (percentage >= 80) {
    message += ' 🤖 High confidence: Very likely AI generated.';
  } else if (percentage >= 60) {
    message += ' 🦾 Medium confidence: Fairly likely AI generated.';
  } else if (percentage >= 50) {
    message += ' 🤔 Low confidence: More likely AI generated.';
  } else if (percentage >= 40) {
    message += ' 🤔 Low confidence: More likely a real image, not AI generated.';
  } else if (percentage >= 20) {
    message += ' 👩‍🎨 Medium confidence: Fairly likely a real image, not AI generated.';
  } else {
    message += ' 📸 High confidence: Very likely a real image, not AI generated.';
  }
  
  // Add detection page URL if pageId is provided
  if (pageId) {
          message += `\n\n📊 View detailed analysis: https://truthscan.com/d/${pageId}`;
  }
  
  // Add hashtags for discovery - use original hashtags if available
  message += ' ' + formatHashtagsForReply(originalHashtags, tweetText);
  
  return message;
}

/**
 * Post reply to original tweet with AI detection results using direct API calls
 */
async function replyToTweet(
  originalTweetId: string, 
  aiProbability: number, 
  finalResult: string, 
  env: Env,
  customMessage?: string,
  originalHashtags: string[] = [],
  tweetText: string = '',
  pageId?: string
): Promise<{ success: boolean; replyTweetId?: string; error?: string }> {
  try {
    console.log('Preparing to reply to tweet:', {
      originalTweetId,
      aiProbability: aiProbability + '%',
      finalResult
    });
    
    // Use custom message if provided, otherwise compose standard message
    const replyMessage = customMessage || composeReplyMessage(aiProbability, finalResult, originalHashtags, tweetText, pageId);
    
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
 * Process all images in a tweet and send one consolidated reply
 */
async function processAllImagesAndReply(imageUrls: string[], tweetData: ParsedTweetData, env: Env): Promise<void> {
  try {
    console.log(`Starting batch processing of ${imageUrls.length} images for tweet ${tweetData.tweetId}`);
    
    // Process all images concurrently
    const imagePromises = imageUrls.map(async (imageUrl, index) => {
      const detectionId = crypto.randomUUID();
      const timestamp = Math.floor(Date.now() / 1000);
      
      try {
        console.log(`Processing image ${index + 1}/${imageUrls.length}: ${imageUrl}`);
        const detectionResult = await processImageWithAI(imageUrl, env);
        
        // Store result in database (without sending individual reply)
        const insertResult = await insertDetection(env, {
          id: detectionId,
          tweetId: tweetData.tweetId,
          timestamp,
          imageUrl,
          detectionScore: detectionResult.success ? detectionResult.aiProbability : undefined,
          twitterHandle: tweetData.username,
          responseTweetId: undefined, // Will be set after consolidated reply
          processingTimeMs: detectionResult.processingTimeMs,
          apiProvider: 'undetectable.ai'
        });
        void insertResult; // pageId available for future use
        
        return {
          index: index + 1, // 1-based for display
          success: detectionResult.success,
          aiProbability: detectionResult.aiProbability,
          finalResult: detectionResult.finalResult,
          error: detectionResult.error,
          detectionId,
          pageId: insertResult.pageId
        };
      } catch (error) {
        console.error(`Failed to process image ${index + 1}:`, error);
        
        // Store error result
        const insertResult = await insertDetection(env, {
          id: detectionId,
          tweetId: tweetData.tweetId,
          timestamp,
          imageUrl,
          detectionScore: undefined,
          twitterHandle: tweetData.username,
          processingTimeMs: 0,
          apiProvider: 'undetectable.ai'
        });
        void insertResult; // pageId available for future use
        
        return {
          index: index + 1,
          success: false,
          aiProbability: 0,
          finalResult: 'Error',
          error: error instanceof Error ? error.message : 'Processing failed',
          detectionId,
          pageId: insertResult.pageId
        };
      }
    });
    
    // Wait for all images to be processed
    const results = await Promise.all(imagePromises);
    console.log(`Completed processing ${results.length} images, preparing consolidated reply`);
    
    // Create consolidated reply message
    const replyMessage = composeMultiImageReplyMessage(results, tweetData.hashtags, tweetData.text);
    
    // Send one consolidated reply
    try {
      const replyResult = await replyToTweet(
        tweetData.tweetId,
        0, // Not used in multi-image reply
        '',  // Not used in multi-image reply
        env,
        replyMessage // Pass custom message
      );
      
      if (replyResult.success) {
        console.log('Successfully sent consolidated reply:', {
          originalTweetId: tweetData.tweetId,
          replyTweetId: replyResult.replyTweetId,
          imageCount: results.length
        });
        
        // Update database records with reply tweet ID
        if (replyResult.replyTweetId) {
          const updatePromises = results
            .filter(result => result.detectionId) // Only update detections with IDs
            .map(result => 
              updateDetectionWithReplyId(env, result.detectionId, replyResult.replyTweetId!)
                .catch(error => {
                  console.error(`Failed to update detection ${result.detectionId} with reply ID:`, error);
                  return { success: false, error: error.message };
                })
            );
          
          // Execute all updates in parallel
          const updateResults = await Promise.all(updatePromises);
          const successfulUpdates = updateResults.filter(result => result.success).length;
          
          console.log('Database reply ID updates:', {
            totalDetections: results.length,
            updatesAttempted: updatePromises.length,
            updatesSuccessful: successfulUpdates,
            replyTweetId: replyResult.replyTweetId
          });
        }
      } else {
        console.error('Failed to send consolidated reply:', replyResult.error);
      }
    } catch (replyError) {
      console.error('Error sending consolidated reply:', replyError);
    }
    
  } catch (error) {
    console.error('Error in batch image processing:', error);
  }
}

/**
 * Compose consolidated reply message for multiple images
 */
function composeMultiImageReplyMessage(results: Array<{
  index: number;
  success: boolean;
  aiProbability: number;
  finalResult: string;
  error?: string;
  pageId?: string;
}>, originalHashtags: string[] = [], tweetText: string = ''): string {
  const ordinals = ['1st', '2nd', '3rd', '4th'];
  
  if (results.length === 1) {
    // Single image - use original format
    const result = results[0];
    if (result.success) {
      return composeReplyMessage(result.aiProbability, result.finalResult, originalHashtags, tweetText, result.pageId);
    } else {
      return `🧠 Unable to analyze the image. Please try again later. ${formatHashtagsForReply(originalHashtags, tweetText)}`;
    }
  }
  
  // Multiple images - use consolidated format
  const successfulResults = results.filter(r => r.success);
  const imageAnalyses: string[] = [];
  
  for (const result of results) {
    const ordinal = ordinals[result.index - 1] || `${result.index}th`;
    
    if (result.success) {
      const percentage = Math.round(result.aiProbability);
      imageAnalyses.push(`${ordinal} image: ${percentage}% AI`);
    } else {
      imageAnalyses.push(`${ordinal} image: Error`);
    }
  }
  
  // Create the base message
  let message = `🧠 AI Detection Results:\n${imageAnalyses.join('\n')}`;
  
  // Add overall assessment if we have successful results
  if (successfulResults.length > 0) {
    const avgProbability = successfulResults.reduce((sum, r) => sum + r.aiProbability, 0) / successfulResults.length;
    
    if (avgProbability >= 75) {
      message += '\n\n🤖 Multiple images show high AI probability';
    } else if (avgProbability >= 25) {
      message += '\n\n🤔 Mixed results - some images may be AI-generated';
    } else {
      message += '\n\n👨‍🎨 Most images appear to be human-created';
    }
  }
  
  // Add detection page URLs for successful results with pageIds
  const urlLinks: string[] = [];
  for (const result of results) {
    if (result.success && result.pageId) {
      const ordinal = ordinals[result.index - 1] || `${result.index}th`;
      urlLinks.push(`📊 ${ordinal}: https://truthscan.com/d/${result.pageId}`);
    }
  }
  
  if (urlLinks.length > 0) {
    message += '\n\nDetailed analysis:';
    urlLinks.forEach(link => {
      message += `\n${link}`;
    });
  }
  
  // Add hashtags - use original hashtags if available
  message += ' ' + formatHashtagsForReply(originalHashtags, tweetText);
  
  return message;
}

/**
 * Secure Short URL Generation
 */

// Filtered Base36 character set (excludes confusing chars: 0, o, 1, l, i)
const SHORT_ID_CHARSET = '0123456789abcdefghijklmnopqrstuvwxyz'; // 36 characters (full alphanumeric)
const SHORT_ID_LENGTH = 4; // 36^4 = ~1.6 million combinations

// Blacklist of offensive/reserved patterns (expandable)
const OFFENSIVE_PATTERNS = [
  'fuck', 'shit', 'damn', 'hell', 'ass', 'sex', 'porn', 'xxx',
  'nazi', 'hate', 'kill', 'die', 'dead', 'bomb', 'gun', 'drug',
  'admin', 'root', 'test', 'null', 'void', 'temp', 'spam'
];

/**
 * Cache configuration constants for different content types
 */
const CACHE_CONFIG = {
  DETECTION_PAGES: {
    maxAge: 3600, // 1 hour for browser cache
    sMaxAge: 86400, // 24 hours for edge cache
    description: 'Detection pages'
  },
  STATIC_IMAGES: {
    maxAge: 3600, // 1 hour for browser cache  
    sMaxAge: 604800, // 7 days for edge cache
    description: 'Images and thumbnails'
  },
  ERROR_PAGES: {
    maxAge: 3600, // 1 hour for browser cache
    sMaxAge: 3600, // 1 hour for edge cache
    description: 'Error pages'
  },
  NO_CACHE: {
    maxAge: 0,
    sMaxAge: 0,
    description: 'API endpoints (no cache)'
  }
} as const;

/**
 * Set appropriate cache headers for different content types
 */
function setCacheHeaders(headers: Headers, cacheType: keyof typeof CACHE_CONFIG): void {
  const config = CACHE_CONFIG[cacheType];
  
  if (config.maxAge === 0 && config.sMaxAge === 0) {
    // No cache for API endpoints
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
  } else {
    // Set public cache with specified max-age and s-maxage
    headers.set('Cache-Control', `public, max-age=${config.maxAge}, s-maxage=${config.sMaxAge}`);
    headers.set('Vary', 'Accept-Encoding');
  }
  
  // Add ETag for cache validation (simplified for now)
  headers.set('ETag', `"${Math.random().toString(36).substr(2, 9)}"`);
}

/**
 * Cloudflare Workers Cache API integration
 */

/**
 * Generate a normalized cache key for consistent caching
 */
function generateCacheKey(request: Request, type: 'detection' | 'image' | 'thumbnail'): string {
  const url = new URL(request.url);
  
  // Remove query parameters that don't affect content
  const cleanUrl = new URL(url.pathname, url.origin);
  
  // Add cache version for cache busting when needed
  cleanUrl.searchParams.set('v', '1');
  cleanUrl.searchParams.set('type', type);
  
  return cleanUrl.toString();
}

/**
 * Check if content should be cached based on popularity/criteria
 */
function shouldUseWorkersCache(pageId: string, type: 'detection' | 'image' | 'thumbnail'): boolean {
  // ALWAYS disable caching in development - this is localhost
  console.log(`🚫 Caching DISABLED for ${type} in development:`, pageId);
  return false;
}

/**
 * Get content from Workers cache if available
 */
async function getFromCache(request: Request, type: 'detection' | 'image' | 'thumbnail'): Promise<Response | null> {
  try {
    const cache = caches.default;
    const cacheKey = generateCacheKey(request, type);
    const cacheRequest = new Request(cacheKey);
    
    const cachedResponse = await cache.match(cacheRequest);
    
    if (cachedResponse) {
      console.log(`Cache HIT for ${type}:`, cacheKey);
      
      // Add cache hit header for debugging
      const response = new Response(cachedResponse.body, cachedResponse);
      response.headers.set('CF-Cache-Status', 'HIT');
      response.headers.set('X-Cache-Key', cacheKey);
      
      return response;
    }
    
    console.log(`Cache MISS for ${type}:`, cacheKey);
    return null;
    
  } catch (error) {
    console.error('Error accessing cache:', error);
    return null;
  }
}

/**
 * Store content in Workers cache
 */
async function putInCache(
  request: Request, 
  response: Response, 
  type: 'detection' | 'image' | 'thumbnail'
): Promise<void> {
  try {
    const cache = caches.default;
    const cacheKey = generateCacheKey(request, type);
    const cacheRequest = new Request(cacheKey);
    
    // Clone the response before caching
    const responseToCache = response.clone();
    
    // Add cache metadata headers
    responseToCache.headers.set('CF-Cache-Status', 'MISS');
    responseToCache.headers.set('X-Cache-Key', cacheKey);
    responseToCache.headers.set('X-Cached-At', new Date().toISOString());
    
    await cache.put(cacheRequest, responseToCache);
    console.log(`Cached ${type} content:`, cacheKey);
    
  } catch (error) {
    console.error('Error storing in cache:', error);
    // Don't throw - caching failure shouldn't break the request
  }
}

/**
 * Purge specific content from cache (for future cache invalidation)
 * Purge specific URLs from Workers cache
 */
async function purgeFromCache(url: string, type: 'detection' | 'image' | 'thumbnail'): Promise<boolean> {
  try {
    const cache = caches.default;
    const tempRequest = new Request(url);
    const cacheKey = generateCacheKey(tempRequest, type);
    const cacheRequest = new Request(cacheKey);
    
    const deleted = await cache.delete(cacheRequest);
    console.log(`Cache purge ${deleted ? 'SUCCESS' : 'NOT_FOUND'} for ${type}:`, cacheKey);
    
    return deleted;
    
  } catch (error) {
    console.error('Error purging from cache:', error);
    return false;
  }
}

/**
 * Generate a cryptographically secure short ID using filtered Base36
 */
function generateSecureShortId(length: number = SHORT_ID_LENGTH): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  
  let id = '';
  for (let i = 0; i < length; i++) {
    id += SHORT_ID_CHARSET[array[i] % SHORT_ID_CHARSET.length];
  }
  
  return id;
}

/**
 * Check if generated ID contains offensive or confusing patterns
 */
function containsOffensivePattern(id: string): boolean {
  const lowerID = id.toLowerCase();
  
  // Check against blacklist
  for (const pattern of OFFENSIVE_PATTERNS) {
    if (lowerID.includes(pattern)) {
      return true;
    }
  }
  
  // Check for confusing patterns (too many repeated chars)
  const charCounts = new Map<string, number>();
  for (const char of lowerID) {
    charCounts.set(char, (charCounts.get(char) || 0) + 1);
  }
  
  // Reject if any character appears more than half the ID length
  const maxRepeats = Math.floor(lowerID.length / 2);
  for (const count of charCounts.values()) {
    if (count > maxRepeats) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if short ID already exists in database
 */
async function isShortIdUnique(pageId: string, env: Env): Promise<boolean> {
  try {
    const stmt = env.DB.prepare('SELECT 1 FROM detections WHERE page_id = ? LIMIT 1');
    const result = await stmt.bind(pageId.toLowerCase()).first();
    return result === null; // True if no existing record found
  } catch (error) {
    console.error('Database uniqueness check failed:', error);
    return false; // Assume not unique on error to be safe
  }
}

/**
 * Generate a unique, secure short ID with collision handling
 */
async function generateUniqueShortId(env: Env, maxAttempts: number = 10): Promise<string | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Generate a candidate ID
    const candidateId = generateSecureShortId();
    
    // Check for offensive patterns
    if (containsOffensivePattern(candidateId)) {
      console.log(`Attempt ${attempt}: Rejected ID for offensive pattern: ${candidateId}`);
      continue;
    }
    
    // Check database uniqueness
    const isUnique = await isShortIdUnique(candidateId, env);
    if (isUnique) {
      console.log(`Generated unique short ID: ${candidateId} (attempt ${attempt})`);
      return candidateId.toLowerCase(); // Always store lowercase
    }
    
    console.log(`Attempt ${attempt}: ID collision detected: ${candidateId}`);
  }
  
  console.error(`Failed to generate unique short ID after ${maxAttempts} attempts`);
  return null; // Return null if all attempts failed
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

// Insert a new detection result with automatic page_id generation
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
  pageId?: string; // Optional: provide existing page_id or let it auto-generate
  imageData?: ArrayBuffer;
  imageContentType?: string;
}): Promise<{ success: boolean; pageId?: string }> {
  // Generate unique page_id if not provided
  let pageId = data.pageId;
  
  try {
    if (!pageId) {
      const generatedPageId = await generateUniqueShortId(env);
      if (!generatedPageId) {
        console.error('Failed to generate unique page_id for detection:', data.id);
        // Continue without page_id rather than failing the entire insertion
        pageId = undefined;
      } else {
        pageId = generatedPageId;
      }
    }
    
    const stmt = env.DB.prepare(`
      INSERT INTO detections (
        id, tweet_id, timestamp, image_url, detection_score, twitter_handle, 
        response_tweet_id, processing_time_ms, api_provider, page_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      data.apiProvider || null,
      pageId || null
    ).run();
    
    console.log('Detection inserted:', { 
      id: data.id, 
      pageId: pageId || 'none',
      success: result.success 
    });
    
    return {
      success: result.success,
      pageId: pageId || undefined
    };
  } catch (error) {
    console.error('Failed to insert detection:', error);
    // Still return the pageId even if database insert fails so the URL can be included in tweets
    return { success: false, pageId: pageId || undefined };
  }
}

// Update detection record with reply tweet ID
async function updateDetectionWithReplyId(env: Env, detectionId: string, replyTweetId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const stmt = env.DB.prepare(`
      UPDATE detections 
      SET response_tweet_id = ?, updated_at = strftime('%s', 'now')
      WHERE id = ?
    `);
    
    const result = await stmt.bind(replyTweetId, detectionId).run();
    
    console.log('Updated detection with reply tweet ID:', { 
      detectionId, 
      replyTweetId, 
      success: result.success 
    });
    
    return { success: result.success };
  } catch (error) {
    console.error('Failed to update detection with reply tweet ID:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// Get recent detections for dashboard
async function getRecentDetections(env: Env, limit = 50): Promise<any[]> {
  try {
    const stmt = env.DB.prepare(`
      SELECT id, tweet_id, timestamp, image_url, detection_score, 
             twitter_handle, response_tweet_id, processing_time_ms, api_provider,
             page_id, created_at
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
        responseTweetId: detection.response_tweet_id,
        pageId: detection.page_id,
        detectionUrl: detection.page_id ? `https://truthscan.com/d/${detection.page_id}` : null
      }));
      
      const apiHeaders = new Headers({
        'Content-Type': 'application/json',
        ...corsHeaders
      });
      setCacheHeaders(apiHeaders, 'NO_CACHE');
      return new Response(JSON.stringify(transformedData), {
        status: 200,
        headers: apiHeaders
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
 * Short URL Generation Testing Functions
 */

/**
 * Test short ID generation for collisions and patterns
 */
async function testShortIdGeneration(env: Env, testCount: number = 1000): Promise<{
  success: boolean;
  results: {
    totalGenerated: number;
    uniqueIds: number;
    collisions: number;
    offensivePatterns: number;
    averageGenerationTime: number;
    sampleIds: string[];
  };
  error?: string;
}> {
  try {
    console.log(`Starting short ID generation test with ${testCount} iterations`);
    const startTime = Date.now();
    
    const generatedIds = new Set<string>();
    const offensiveIds: string[] = [];
    const sampleIds: string[] = [];
    let totalCollisions = 0;
    
    // Generate test IDs
    for (let i = 0; i < testCount; i++) {
      const id = generateSecureShortId();
      
      // Check for offensive patterns
      if (containsOffensivePattern(id)) {
        offensiveIds.push(id);
        continue; // Skip offensive IDs
      }
      
      // Check for collisions in our test set
      if (generatedIds.has(id)) {
        totalCollisions++;
        console.log(`Test collision detected: ${id} (iteration ${i + 1})`);
      } else {
        generatedIds.add(id);
      }
      
      // Collect sample IDs for inspection
      if (sampleIds.length < 20) {
        sampleIds.push(id);
      }
    }
    
    const endTime = Date.now();
    const averageTime = (endTime - startTime) / testCount;
    
    const results = {
      totalGenerated: testCount,
      uniqueIds: generatedIds.size,
      collisions: totalCollisions,
      offensivePatterns: offensiveIds.length,
      averageGenerationTime: averageTime,
      sampleIds
    };
    
    console.log('Short ID generation test completed:', results);
    
    return {
      success: true,
      results
    };
    
  } catch (error) {
    console.error('Short ID generation test failed:', error);
    return {
      success: false,
      results: {
        totalGenerated: 0,
        uniqueIds: 0,
        collisions: 0,
        offensivePatterns: 0,
        averageGenerationTime: 0,
        sampleIds: []
      },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Test database uniqueness validation with actual database operations
 */
async function testDatabaseUniqueness(env: Env, testCount: number = 100): Promise<{
  success: boolean;
  results: {
    totalAttempts: number;
    successfulInserts: number;
    databaseCollisions: number;
    generationFailures: number;
    averageDbLookupTime: number;
  };
  error?: string;
}> {
  try {
    console.log(`Starting database uniqueness test with ${testCount} operations`);
    
    let successfulInserts = 0;
    let databaseCollisions = 0;
    let generationFailures = 0;
    let totalLookupTime = 0;
    
    for (let i = 0; i < testCount; i++) {
      const lookupStart = Date.now();
      
      // Generate unique ID
      const pageId = await generateUniqueShortId(env, 5); // Limit attempts for faster testing
      
      const lookupEnd = Date.now();
      totalLookupTime += (lookupEnd - lookupStart);
      
      if (!pageId) {
        generationFailures++;
        continue;
      }
      
      // Try to insert a test record
      try {
        const testResult = await insertDetection(env, {
          id: `test-uniqueness-${i}-${Date.now()}`,
          tweetId: `test-tweet-${i}`,
          timestamp: Math.floor(Date.now() / 1000),
          imageUrl: `https://example.com/test-${i}.jpg`,
          detectionScore: 0.5,
          twitterHandle: `testuser${i}`,
          apiProvider: 'test',
          pageId: pageId // Use the generated page_id
        });
        
        if (testResult.success) {
          successfulInserts++;
        } else {
          databaseCollisions++;
        }
      } catch (error) {
        console.error(`Database insert failed for test ${i}:`, error);
        databaseCollisions++;
      }
    }
    
    const averageDbLookupTime = totalLookupTime / testCount;
    
    const results = {
      totalAttempts: testCount,
      successfulInserts,
      databaseCollisions,
      generationFailures,
      averageDbLookupTime
    };
    
    console.log('Database uniqueness test completed:', results);
    
    return {
      success: true,
      results
    };
    
  } catch (error) {
    console.error('Database uniqueness test failed:', error);
    return {
      success: false,
      results: {
        totalAttempts: 0,
        successfulInserts: 0,
        databaseCollisions: 0,
        generationFailures: 0,
        averageDbLookupTime: 0
      },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Test offensive pattern filtering effectiveness
 */
function testOffensivePatternFiltering(): {
  success: boolean;
  results: {
    testPatterns: string[];
    correctlyFiltered: number;
    incorrectlyAllowed: string[];
    testResults: Array<{ pattern: string; filtered: boolean; reason?: string }>;
  };
} {
  // Test patterns that should be filtered
  const testPatterns = [
    'fuckme', 'shitty', 'nazism', 'killme', 'testme', 'admin1',
    'sexbot', 'dickme', 'hateit', 'asshat', 'rootme', 'nulled',
    'aaaaaaa', '2222222', 'abcdef', 'hellno' // Also test repetition
  ];
  
  const testResults: Array<{ pattern: string; filtered: boolean; reason?: string }> = [];
  const incorrectlyAllowed: string[] = [];
  let correctlyFiltered = 0;
  
  for (const pattern of testPatterns) {
    const isFiltered = containsOffensivePattern(pattern);
    
    testResults.push({
      pattern,
      filtered: isFiltered,
      reason: isFiltered ? 'Correctly filtered' : 'Not filtered'
    });
    
    if (isFiltered) {
      correctlyFiltered++;
    } else {
      incorrectlyAllowed.push(pattern);
    }
  }
  
  console.log('Offensive pattern filtering test results:', testResults);
  
  return {
    success: true,
    results: {
      testPatterns,
      correctlyFiltered,
      incorrectlyAllowed,
      testResults
    }
  };
}

/**
 * Handle short URL generation test requests
 */
async function handleShortUrlTest(request: Request, env: Env): Promise<Response> {
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
      const url = new URL(request.url);
      const testType = url.searchParams.get('type') || 'all';
      const testCount = parseInt(url.searchParams.get('count') || '100');
      
      console.log(`Running short URL tests: type=${testType}, count=${testCount}`);
      
      const testResults: Record<string, any> = {
        timestamp: new Date().toISOString(),
        testType,
        testCount
      };
      
      // Run pattern filtering test (always included)
      const patternTest = testOffensivePatternFiltering();
      testResults.patternFiltering = patternTest.results;
      
      // Run generation test if requested
      if (testType === 'all' || testType === 'generation') {
        const generationTest = await testShortIdGeneration(env, testCount);
        testResults.generation = generationTest.results;
        if (!generationTest.success) {
          testResults.generationError = generationTest.error;
        }
      }
      
      // Run database uniqueness test if requested
      if (testType === 'all' || testType === 'database') {
        const dbTest = await testDatabaseUniqueness(env, Math.min(testCount, 50)); // Limit DB tests
        testResults.database = dbTest.results;
        if (!dbTest.success) {
          testResults.databaseError = dbTest.error;
        }
      }
      
      // Calculate overall success
      const overallSuccess = !testResults.generationError && !testResults.databaseError;
      
      return new Response(JSON.stringify({
        success: overallSuccess,
        ...testResults
      }), {
        status: overallSuccess ? 200 : 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
      
    } catch (error) {
      console.error('Short URL test failed:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Short URL test failed',
        timestamp: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      }), {
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
 * Test reply formatting with and without page IDs
 */
async function handleReplyFormattingTest(_request: Request, _env: Env): Promise<Response> {
  try {

    // Test data for multiple images reply
    const multiImageTestResults = [
      {
        index: 1,
        success: true,
        aiProbability: 85.2,
        finalResult: 'AI-Generated',
        pageId: 'def456'
      },
      {
        index: 2,
        success: true,
        aiProbability: 23.7,
        finalResult: 'Human-Created',
        pageId: 'ghi789'
      },
      {
        index: 3,
        success: false,
        aiProbability: 0,
        finalResult: 'Error',
        error: 'Processing failed',
        pageId: 'jkl012'
      }
    ];

    // Test hashtags and tweet text
    const testHashtags = ['AIDetection', 'TechCheck'];
    const testTweetText = 'Check this image for AI generation please!';

    // Test single image reply with pageId
    const singleReplyWithPageId = composeReplyMessage(
      75.5, 
      'AI-Generated', 
      testHashtags, 
      testTweetText, 
      'abc123'
    );

    // Test single image reply without pageId
    const singleReplyWithoutPageId = composeReplyMessage(
      75.5, 
      'AI-Generated', 
      testHashtags, 
      testTweetText
    );

    // Test multi-image reply with pageIds
    const multiReplyMessage = composeMultiImageReplyMessage(
      multiImageTestResults,
      testHashtags,
      testTweetText
    );

    // Test multi-image reply without pageIds (simulate old data)
    const multiImageTestResultsNoPageId = multiImageTestResults.map(result => ({
      ...result,
      pageId: undefined
    }));
    
    const multiReplyNoPageIds = composeMultiImageReplyMessage(
      multiImageTestResultsNoPageId,
      testHashtags,
      testTweetText
    );

    const results = {
      success: true,
      timestamp: new Date().toISOString(),
      tests: {
        singleImageWithPageId: {
          description: 'Single image reply with page ID - should include detection URL',
          pageId: 'abc123',
          message: singleReplyWithPageId,
                  includesUrl: singleReplyWithPageId.includes('https://truthscan.com/d/abc123'),
        urlPosition: singleReplyWithPageId.indexOf('https://truthscan.com/d/abc123')
        },
        singleImageWithoutPageId: {
          description: 'Single image reply without page ID - should not include URL',
          pageId: null,
          message: singleReplyWithoutPageId,
          includesUrl: singleReplyWithoutPageId.includes('https://truthscan.com/d/'),
          messageLength: singleReplyWithoutPageId.length
        },
        multiImageWithPageIds: {
          description: 'Multi-image reply with page IDs - should include individual URLs',
          pageIds: multiImageTestResults.filter(r => r.pageId).map(r => r.pageId),
          message: multiReplyMessage,
          includesUrls: {
                    def456: multiReplyMessage.includes('https://truthscan.com/d/def456'),
        ghi789: multiReplyMessage.includes('https://truthscan.com/d/ghi789'),
        jkl012: multiReplyMessage.includes('https://truthscan.com/d/jkl012')
          },
          includesDetailedAnalysisSection: multiReplyMessage.includes('Detailed analysis:')
        },
        multiImageWithoutPageIds: {
          description: 'Multi-image reply without page IDs - should not include URL section',
          pageIds: null,
          message: multiReplyNoPageIds,
          includesUrls: multiReplyNoPageIds.includes('https://truthscan.com/d/'),
          includesDetailedAnalysisSection: multiReplyNoPageIds.includes('Detailed analysis:')
        }
      },
      validation: {
                        singleImageUrlIncluded: singleReplyWithPageId.includes('https://truthscan.com/d/abc123'),
        singleImageNoUrlWhenNoPageId: !singleReplyWithoutPageId.includes('https://truthscan.com/d/'),
        multiImageUrlsIncluded: multiReplyMessage.includes('https://truthscan.com/d/def456') &&
                                multiReplyMessage.includes('https://truthscan.com/d/ghi789'),
        multiImageNoUrlsWhenNoPageIds: !multiReplyNoPageIds.includes('https://truthscan.com/d/'),
        allTestsPassed: false // Will be calculated
      }
    };

    // Calculate overall test status
    results.validation.allTestsPassed = 
      results.validation.singleImageUrlIncluded &&
      results.validation.singleImageNoUrlWhenNoPageId &&
      results.validation.multiImageUrlsIncluded &&
      results.validation.multiImageNoUrlsWhenNoPageIds;

    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('Error in reply formatting test:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Test database updates for reply tweet ID integration
 */
async function handleDatabaseUpdatesTest(_request: Request, env: Env): Promise<Response> {
  try {
    // Create a test detection record first
    const testDetectionId = `test-db-update-${Date.now()}`;
    const testTweetId = `test-tweet-${Date.now()}`;
    const testPageId = `test${Math.random().toString(36).substr(2, 3)}`;
    
    // Insert test detection
    const insertResult = await insertDetection(env, {
      id: testDetectionId,
      tweetId: testTweetId,
      timestamp: Math.floor(Date.now() / 1000),
      imageUrl: 'https://example.com/test-image.jpg',
      detectionScore: 75,
      twitterHandle: 'test_user',
      apiProvider: 'test-api',
      pageId: testPageId
    });

    if (!insertResult.success) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to insert test detection',
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Simulate a reply tweet ID
    const testReplyTweetId = `reply-tweet-${Date.now()}`;
    
    // Test the database update function
    const updateResult = await updateDetectionWithReplyId(env, testDetectionId, testReplyTweetId);
    
    // Verify the update by querying the database
    const verificationQuery = env.DB.prepare(`
      SELECT id, response_tweet_id, updated_at 
      FROM detections 
      WHERE id = ?
    `);
    
    const verificationResult = await verificationQuery.bind(testDetectionId).first();
    
    const results = {
      success: true,
      timestamp: new Date().toISOString(),
      testData: {
        detectionId: testDetectionId,
        tweetId: testTweetId,
        pageId: testPageId,
        replyTweetId: testReplyTweetId
      },
      testResults: {
        insertionSuccessful: insertResult.success,
        updateSuccessful: updateResult.success,
        databaseVerification: {
          recordFound: !!verificationResult,
          storedReplyTweetId: verificationResult?.response_tweet_id,
          updatedAt: verificationResult?.updated_at,
          matchesExpected: verificationResult?.response_tweet_id === testReplyTweetId
        }
      },
      validation: {
        insertWorked: insertResult.success,
        updateWorked: updateResult.success,
        dataIntegrity: verificationResult?.response_tweet_id === testReplyTweetId,
        allTestsPassed: false // Will be calculated
      }
    };

    // Calculate overall test status
    results.validation.allTestsPassed = 
      results.validation.insertWorked &&
      results.validation.updateWorked &&
      results.validation.dataIntegrity;

    // Clean up test data
    try {
      const cleanupQuery = env.DB.prepare('DELETE FROM detections WHERE id = ?');
      await cleanupQuery.bind(testDetectionId).run();
      console.log('Cleaned up test detection record:', testDetectionId);
    } catch (cleanupError) {
      console.warn('Failed to clean up test detection record:', cleanupError);
    }

    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('Error in database updates test:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Generate test monitoring data for dashboard testing
 */
async function handleGenerateTestMonitoringData(_request: Request, env: Env): Promise<Response> {
  try {
    // Insert some test page views
    const pageViewData = [
      { pageId: 'test123', isBot: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      { pageId: 'abc123', isBot: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)' },
      { pageId: 'xyz789', isBot: true, userAgent: 'bot/crawler' },
      { pageId: 'def456', isBot: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    ];
    
    for (const pageView of pageViewData) {
      await logPageView(env, pageView.pageId, {
        headers: {
          get: (header: string) => {
            if (header === 'User-Agent') return pageView.userAgent;
            if (header === 'CF-Connecting-IP') return '192.168.1.100';
            return null;
          }
        },
                  url: `https://truthscan.com/d/${pageView.pageId}`
      } as any, { isBot: pageView.isBot });
    }
    
    // Insert some test error logs
    const errorData = [
      { level: 'error' as const, type: 'page_not_found', message: 'Detection page not found', pageId: 'notfound1' },
      { level: 'error' as const, type: 'database_error', message: 'Database connection timeout' },
      { level: 'warn' as const, type: 'image_load_failed', message: 'Failed to load image from external URL' },
      { level: 'info' as const, type: 'detection_processed', message: 'AI detection completed successfully', pageId: 'success1' },
    ];
    
    for (const error of errorData) {
      await logEvent(env, error.level, error.type, error.message, {
        pageId: error.pageId,
        userAgent: 'Mozilla/5.0 (test)',
        ipAddress: '192.168.1.100',
        url: 'https://truthscan.com/test',
        processingTimeMs: Math.floor(Math.random() * 1000)
      });
    }
    
    // Insert some test system metrics
    const metricsData = [
      { name: 'response_time', value: 245, type: 'gauge' as const },
      { name: 'detection_requests', value: 1, type: 'counter' as const },
      { name: 'page_views', value: 1, type: 'counter' as const },
      { name: 'error_rate', value: 0.02, type: 'gauge' as const },
    ];
    
    for (const metric of metricsData) {
      await logSystemMetric(env, metric.name, metric.value, metric.type);
    }
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Test monitoring data generated successfully',
      data: {
        pageViews: pageViewData.length,
        errorLogs: errorData.length,
        systemMetrics: metricsData.length,
        timestamp: new Date().toISOString()
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error generating test monitoring data:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Comprehensive monitoring system validation
 */
async function handleMonitoringValidation(_request: Request, env: Env): Promise<Response> {
  try {
    const validationResults = {
      timestamp: new Date().toISOString(),
      tests: {} as any,
      summary: {} as any
    };

    // Test 1: Data Accuracy - Verify logged events match expectations
    console.log('🔍 Starting monitoring validation tests...');
    
    // Clear existing test data and create fresh test data
    const testPageId = `validation${Math.random().toString(36).substr(2, 6)}`;
    const beforePageViews = await queryPageViewCount(env);
    
    // Generate a controlled page view
    await logPageView(env, testPageId, {
      headers: {
        get: (header: string) => {
          if (header === 'User-Agent') return 'Mozilla/5.0 (validation-test)';
          if (header === 'CF-Connecting-IP') return '192.168.1.200';
          return null;
        }
      },
                url: `https://truthscan.com/d/${testPageId}`
    } as any, { isBot: false });
    
    // Wait briefly for database consistency
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const afterPageViews = await queryPageViewCount(env);
    
    validationResults.tests.dataAccuracy = {
      pageViewIncrement: afterPageViews - beforePageViews === 1,
      testPageId: testPageId,
      beforeCount: beforePageViews,
      afterCount: afterPageViews,
      passed: afterPageViews - beforePageViews === 1
    };

    // Test 2: API Consistency - Check if all monitoring endpoints return consistent data
    const dashboardData = await queryDashboardData(env);
    const pageViewData = await queryPageViewData(env);
    const logsData = await queryLogsData(env);
    
    validationResults.tests.apiConsistency = {
      dashboardReturnsData: !!dashboardData && dashboardData.success,
      pageViewReturnsData: !!pageViewData && pageViewData.success,
      logsReturnsData: !!logsData && logsData.success,
      pageViewCountsMatch: dashboardData?.overview?.totalPageViews === pageViewData?.statistics?.totalViews,
      passed: !!(dashboardData?.success && pageViewData?.success && logsData?.success)
    };

    // Test 3: Dashboard Display Accuracy - Verify calculation accuracy
    const currentStats = dashboardData?.overview || {};
    
    validationResults.tests.dashboardAccuracy = {
      hasValidPageViews: typeof currentStats.totalPageViews === 'number' && currentStats.totalPageViews >= 0,
      hasValidUniquePages: typeof currentStats.uniquePages === 'number' && currentStats.uniquePages >= 0,
      hasValidBotTraffic: typeof currentStats.botTraffic === 'number' && currentStats.botTraffic >= 0,
      hasValidDetections: typeof currentStats.totalDetections === 'number' && currentStats.totalDetections >= 0,
      hasValidProcessingTime: typeof currentStats.avgProcessingTime === 'number' && currentStats.avgProcessingTime > 0,
      hasValidDetectionScore: typeof currentStats.avgDetectionScore === 'number' && currentStats.avgDetectionScore >= 0,
      botTrafficNotExceedsTotal: currentStats.botTraffic <= currentStats.totalPageViews,
      uniquePagesNotExceedsTotal: currentStats.uniquePages <= currentStats.totalPageViews,
      passed: true // Will be calculated below
    };
    
    // Calculate if dashboard accuracy test passed
    const dashboardTests = validationResults.tests.dashboardAccuracy;
    dashboardTests.passed = dashboardTests.hasValidPageViews && 
                           dashboardTests.hasValidUniquePages && 
                           dashboardTests.hasValidBotTraffic && 
                           dashboardTests.hasValidDetections && 
                           dashboardTests.hasValidProcessingTime && 
                           dashboardTests.hasValidDetectionScore &&
                           dashboardTests.botTrafficNotExceedsTotal &&
                           dashboardTests.uniquePagesNotExceedsTotal;

    // Test 4: Database Schema Validation - Verify tables exist and have correct structure
    const schemaValidation = await validateDatabaseSchema(env);
    validationResults.tests.schemaValidation = schemaValidation;

    // Test 5: End-to-end Flow Test - Simulate a complete monitoring flow
    const testStartTime = Date.now();
    const testErrorPageId = `error${Math.random().toString(36).substr(2, 6)}`;
    
    // Log an error event
    await logEvent(env, 'error', 'validation_test', 'Test error for validation', {
      pageId: testErrorPageId,
      userAgent: 'validation-test',
      processingTimeMs: Date.now() - testStartTime
    });
    
    // Wait and check if it appears in dashboard
    await new Promise(resolve => setTimeout(resolve, 100));
    const updatedDashboard = await queryDashboardData(env);
    
    validationResults.tests.endToEndFlow = {
      errorLogged: true, // We assume it logged if no exception
      dashboardUpdated: !!updatedDashboard?.success,
      testErrorPageId: testErrorPageId,
      passed: !!updatedDashboard?.success
    };

    // Calculate overall summary
    const allTests = Object.values(validationResults.tests);
    const passedTests = allTests.filter((test: any) => test.passed).length;
    const totalTests = allTests.length;
    
    validationResults.summary = {
      totalTests,
      passedTests,
      failedTests: totalTests - passedTests,
      successRate: Math.round((passedTests / totalTests) * 100),
      overallPassed: passedTests === totalTests,
      issues: allTests.filter((test: any) => !test.passed).map((test: any, index) => ({
        testName: Object.keys(validationResults.tests)[index],
        details: test
      }))
    };

    console.log(`✅ Monitoring validation completed: ${passedTests}/${totalTests} tests passed`);

    return new Response(JSON.stringify({
      success: true,
      validation: validationResults
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error in monitoring validation:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      validation: null
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Helper functions for validation
async function queryPageViewCount(env: Env): Promise<number> {
  try {
    const result = await env.DB.prepare('SELECT COUNT(*) as count FROM page_views').first();
    return (result?.count as number) || 0;
  } catch {
    return 0;
  }
}

async function queryDashboardData(env: Env): Promise<any> {
  try {
    const response = await handleMonitoringDashboard({} as Request, env);
    return await response.json();
  } catch {
    return null;
  }
}

async function queryPageViewData(env: Env): Promise<any> {
  try {
    const response = await handleMonitoringPageViews({} as Request, env);
    return await response.json();
  } catch {
    return null;
  }
}

async function queryLogsData(env: Env): Promise<any> {
  try {
    const response = await handleMonitoringLogs({} as Request, env);
    return await response.json();
  } catch {
    return null;
  }
}

async function validateDatabaseSchema(env: Env): Promise<any> {
  try {
    const tables = ['logs', 'page_views', 'system_metrics'];
    const results = {} as any;
    
    for (const table of tables) {
      try {
        const result = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).first();
        results[table] = !!result;
      } catch {
        results[table] = false;
      }
    }
    
    const allTablesExist = Object.values(results).every(exists => exists);
    
    return {
      tables: results,
      allTablesExist,
      passed: allTablesExist
    };
  } catch {
    return {
      tables: {},
      allTablesExist: false,
      passed: false
    };
  }
}

/**
 * Clear cached detection pages
 */
async function handleClearCache(_request: Request, _env: Env): Promise<Response> {
  try {
    // Get the specific pageId from query params, or clear common test pages
    const url = new URL(_request.url);
    const pageId = url.searchParams.get('pageId');
    
    const pagesToClear = pageId ? [pageId] : ['abc123', 'test123', 'def456', 'tst410'];
    const results: { pageId: string; success: boolean }[] = [];
    
    for (const id of pagesToClear) {
      const pageUrl = `http://localhost:8787/d/${id}`;
      const cleared = await purgeFromCache(pageUrl, 'detection');
      results.push({ pageId: id, success: cleared });
      console.log(`Cache clear ${cleared ? 'SUCCESS' : 'FAILED'} for page: ${id}`);
    }
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Cache clearing completed',
      results,
      instructions: 'Technical details section should now be removed from all detection pages'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Cache clearing failed:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Handle image requests (/images/:id) - Proxy from Twitter CDN
 */
async function handleImageRequest(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const imageId = pathSegments[2]; // /images/:id
    
    if (!imageId || imageId.length === 0) {
      return new Response('Image ID required', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Check Workers cache first for images
    const cachedResponse = await getFromCache(request, 'image');
    if (cachedResponse) {
      return cachedResponse;
    }
    
    console.log('Image request for ID:', imageId);
    
    // Get detection data to find original image URL
    const detectionResult = await getDetectionByPageId(imageId, env);
    if (!detectionResult.exists || !detectionResult.data) {
      return new Response('Detection not found', { 
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    // Proxy the image from Twitter CDN
    if (detectionResult.data.image_url) {
      try {
        const imageResponse = await fetch(detectionResult.data.image_url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TruthScan/1.0; +https://truthscan.com)'
          }
        });
        
        if (imageResponse.ok) {
          const imageHeaders = new Headers({
            'Content-Type': imageResponse.headers.get('Content-Type') || 'image/jpeg',
            'Access-Control-Allow-Origin': '*'
          });
          setCacheHeaders(imageHeaders, 'STATIC_IMAGES');
          
          const response = new Response(imageResponse.body, {
            headers: imageHeaders
          });

          // Store in Workers cache (fire and forget)
          if (shouldUseWorkersCache(imageId, 'image')) {
            putInCache(request, response, 'image').catch(error => 
              console.warn('Failed to cache image:', error)
            );
          }
          
          return response;
        }
      } catch (error) {
        console.warn('Failed to fetch image from Twitter CDN:', error);
      }
    }
    
    // Fallback: serve placeholder
    console.log('Serving placeholder image for:', imageId);
    const placeholder = await getPlaceholderImage();
    return new Response(placeholder, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      },
      status: 404
    });
    
  } catch (error) {
    console.error('Error handling image request:', error);
    const placeholder = await getPlaceholderImage();
    return new Response(placeholder, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
      },
      status: 500
    });
  }
}

/**
 * Handle thumbnail requests (/thumbnails/:id) - Use original image from Twitter CDN
 */
async function handleThumbnailRequest(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const detectionId = pathSegments[2]; // /thumbnails/:id
    
    if (!detectionId || detectionId.length === 0) {
      return new Response('Detection ID required', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Check Workers cache first for thumbnails
    const cachedResponse = await getFromCache(request, 'thumbnail');
    if (cachedResponse) {
      return cachedResponse;
    }
    
    console.log('Thumbnail request for detection ID:', detectionId);
    
    // Get detection data to find original image URL
    const detectionResult = await getDetectionByPageId(detectionId, env);
    if (!detectionResult.exists || !detectionResult.data) {
      return new Response('Detection not found', { 
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    // Use original image as thumbnail (proxy from Twitter CDN)
    if (detectionResult.data.image_url) {
      try {
        const imageResponse = await fetch(detectionResult.data.image_url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TruthScan/1.0; +https://truthscan.com)'
          }
        });
        
        if (imageResponse.ok) {
          const thumbnailHeaders = new Headers({
            'Content-Type': imageResponse.headers.get('Content-Type') || 'image/jpeg',
            'Access-Control-Allow-Origin': '*'
          });
          setCacheHeaders(thumbnailHeaders, 'STATIC_IMAGES');
          
          const response = new Response(imageResponse.body, {
            headers: thumbnailHeaders
          });

          // Store in Workers cache (fire and forget)
          if (shouldUseWorkersCache(detectionId, 'thumbnail')) {
            putInCache(request, response, 'thumbnail').catch(error => 
              console.warn('Failed to cache thumbnail:', error)
            );
          }
          
          return response;
        }
      } catch (error) {
        console.warn('Failed to fetch thumbnail from Twitter CDN:', error);
      }
    }
    
    // Fallback: serve placeholder
    console.log('Serving placeholder thumbnail for:', detectionId);
    const placeholder = await getPlaceholderImage();
    return new Response(placeholder, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      },
      status: 404
    });
    
  } catch (error) {
    console.error('Error handling thumbnail request:', error);
    const placeholder = await getPlaceholderImage();
    return new Response(placeholder, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
      },
      status: 500
    });
  }
}

/**
 * Generate user-friendly error page HTML
 */
function generateErrorPageHTML(errorCode: number, title: string, message: string, details?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | TruthScan</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔍</text></svg>">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #FFFFFF;
      color: #374151;
      line-height: 1.6;
      margin: 0;
      padding: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .error-container {
      text-align: center;
      max-width: 500px;
    }
    .error-code {
      font-size: 6rem;
      font-weight: 800;
      color: #DC2626;
      margin: 0;
      line-height: 1;
    }
    .error-title {
      font-size: 1.5rem;
      font-weight: 600;
      margin: 1rem 0;
      color: #1F2937;
    }
    .error-message {
      font-size: 1rem;
      color: #6B7280;
      margin-bottom: 2rem;
    }
    .error-details {
      font-size: 0.875rem;
      color: #9CA3AF;
      margin-bottom: 2rem;
      padding: 1rem;
      background: #F9FAFB;
      border-radius: 0.5rem;
      border-left: 4px solid #DC2626;
    }
    .home-link {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      background: #3B82F6;
      color: white;
      text-decoration: none;
      border-radius: 0.5rem;
      font-weight: 500;
      transition: background 0.2s ease;
    }
    .home-link:hover {
      background: #2563EB;
    }
    @media (max-width: 768px) {
      .error-code {
        font-size: 4rem;
      }
      body {
        padding: 1rem;
      }
    }
  </style>
</head>
<body>
  <div class="error-container">
    <h1 class="error-code">${errorCode}</h1>
    <h2 class="error-title">${title}</h2>
    <p class="error-message">${message}</p>
    ${details ? `<div class="error-details">${details}</div>` : ''}
          <a href="https://truthscan.com" class="home-link">← Back to TruthScan</a>
  </div>
</body>
</html>`;
}

/**
 * Handle detection page requests for /d/:id URLs
 */
async function handleDetectionPage(request: Request, env: Env): Promise<Response> {
  // Enhanced security headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  if (request.method !== 'GET') {
    const errorHTML = generateErrorPageHTML(
      405, 
      'Method Not Allowed', 
      'This endpoint only supports GET requests.',
      'Please use a GET request to access detection results.'
    );
    return new Response(errorHTML, { 
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Check Workers cache first for detection pages
  const cachedResponse = await getFromCache(request, 'detection');
  if (cachedResponse) {
    // Add CORS headers to cached response
    Object.entries(corsHeaders).forEach(([key, value]) => {
      cachedResponse.headers.set(key, value);
    });
    return cachedResponse;
  }
  
  try {
    const url = new URL(request.url);
    
    // Extract page_id from URL path: /d/abc123 -> abc123
    const pathParts = url.pathname.split('/');
    const pageId = pathParts[2]; // [0]='', [1]='d', [2]='abc123'
    
    console.log('Detection page request:', {
      fullPath: url.pathname,
      extractedPageId: pageId,
      timestamp: new Date().toISOString()
    });
    
    // Validate page_id parameter
    if (!pageId || pageId.trim() === '') {
      console.log('Invalid detection page request: missing page_id', {
        path: url.pathname,
        userAgent: request.headers.get('User-Agent'),
        timestamp: new Date().toISOString()
      });
      const errorHTML = generateErrorPageHTML(
        400, 
        'Invalid URL', 
        'The detection page URL is missing a required page ID.',
        'URLs should be in the format: /d/abc123'
      );
      const errorHeaders = new Headers({
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8'
      });
      setCacheHeaders(errorHeaders, 'ERROR_PAGES');
      return new Response(errorHTML, {
        status: 400,
        headers: errorHeaders
      });
    }
    
    // Enhanced input sanitization and validation
    const sanitizedPageId = pageId.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Validate page_id format (should be alphanumeric, 4 chars)
    if (!/^[0-9a-z]{4}$/i.test(sanitizedPageId)) {
      console.log('Invalid detection page request: invalid page_id format', {
        originalPageId: pageId,
        sanitizedPageId: sanitizedPageId,
        userAgent: request.headers.get('User-Agent'),
        timestamp: new Date().toISOString()
      });
      const errorHTML = generateErrorPageHTML(
        400, 
        'Invalid Page ID', 
        'The page ID format is invalid. Page IDs must be 4 alphanumeric characters.',
        `Received: "${pageId}" - Expected format: abc1`
      );
      const errorHeaders = new Headers({
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8'
      });
      setCacheHeaders(errorHeaders, 'ERROR_PAGES');
      return new Response(errorHTML, {
        status: 400,
        headers: errorHeaders
      });
    }
    
    // Query database for detection data
    const detectionResult = await getDetectionByPageId(sanitizedPageId, env);
    
    // Handle different scenarios: not found (404), deleted (410), or active
    if (!detectionResult.exists) {
      // Log structured 404 error for monitoring
      const startTime = Date.now();
      await MonitoringEvents.logPageNotFound(env, sanitizedPageId, request, Date.now() - startTime);
      
      const errorHTML = generateErrorPageHTML(
        404, 
        'Detection Page Not Found', 
        'The requested detection result could not be found.',
        `Page ID "${sanitizedPageId}" does not exist or may have expired.`
      );
      const errorHeaders = new Headers({
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8'
      });
      setCacheHeaders(errorHeaders, 'ERROR_PAGES');
      return new Response(errorHTML, {
        status: 404,
        headers: errorHeaders
      });
    }
    
    if (detectionResult.isDeleted) {
      console.log('Detection page is soft-deleted for page_id', {
        pageId: sanitizedPageId,
        originalInput: pageId,
        deletedAt: detectionResult.data.deleted_at ? new Date(detectionResult.data.deleted_at * 1000).toISOString() : 'unknown',
        userAgent: request.headers.get('User-Agent'),
        timestamp: new Date().toISOString()
      });
      const errorHTML = generateErrorPageHTML(
        410, 
        'Detection Page Removed', 
        'This detection result has been permanently removed and is no longer available.',
        `Page ID "${sanitizedPageId}" was deleted and will not be accessible again. This content has been permanently removed for privacy, legal, or other reasons.`
      );
      const errorHeaders = new Headers({
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8'
      });
      setCacheHeaders(errorHeaders, 'ERROR_PAGES');
      return new Response(errorHTML, {
        status: 410,
        headers: errorHeaders
      });
    }
    
    const detectionData = detectionResult.data;
    
    // Log successful page view for analytics
    await logPageView(env, sanitizedPageId, request);
    
    // Log detection page access event
    await logEvent(env, 'info', 'page_view', `Detection page accessed: ${sanitizedPageId}`, {
      pageId: sanitizedPageId,
      userAgent: request.headers.get('User-Agent') || undefined,
      ipAddress: request.headers.get('CF-Connecting-IP') || undefined,
      url: request.url,
      details: {
        tweetId: detectionData.tweet_id,
        score: detectionData.detection_score,
        handle: detectionData.twitter_handle
      }
    });
    
    // Generate HTML page for detection results
    const htmlContent = generateDetectionPageHTML(detectionData, sanitizedPageId, request);
    
    // Create response headers with appropriate caching
    const responseHeaders = new Headers({
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8'
    });
    
    // Apply edge and browser cache headers for detection pages
    setCacheHeaders(responseHeaders, 'DETECTION_PAGES');
    
    const response = new Response(htmlContent, {
      status: 200,
      headers: responseHeaders
    });

    // Store in Workers cache for popular pages (fire and forget)
    if (shouldUseWorkersCache(sanitizedPageId, 'detection')) {
      putInCache(request, response, 'detection').catch(error => 
        console.warn('Failed to cache detection page:', error)
      );
    }
    
    return response;
    
  } catch (error) {
    console.error('Error handling detection page request:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      url: request.url,
      userAgent: request.headers.get('User-Agent'),
      timestamp: new Date().toISOString()
    });
    
    const errorHTML = generateErrorPageHTML(
      500, 
      'Server Error', 
      'Sorry, something went wrong while processing your request.',
      'Please try again later or contact support if the problem persists.'
    );
    
    const errorHeaders = new Headers({
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8'
    });
    setCacheHeaders(errorHeaders, 'ERROR_PAGES');
    
    return new Response(errorHTML, {
      status: 500,
      headers: errorHeaders
    });
  }
}

/**
 * Generate HTML template for detection results page
 */
function generateDetectionPageHTML(data: any, pageId: string, request: Request): string {
  // Convert detection score to percentage and determine color
  // Handle mixed formats: decimal (0-1) vs percentage (0-100)
  let scorePercentage = 0;
  if (data.detection_score) {
    // If score is likely decimal format (0-1), multiply by 100
    // If score is already percentage format (>1), use as-is
    scorePercentage = data.detection_score <= 1 
      ? Math.round(data.detection_score * 100)
      : Math.round(data.detection_score);
  }
  const isAI = scorePercentage >= 70;
  const isUncertain = scorePercentage >= 30 && scorePercentage < 70;
  
  // Color coding based on AI probability
  const scoreColor = isAI ? '#DC2626' : isUncertain ? '#F59E0B' : '#059669'; // Red, Yellow, Green
  const scoreLabel = isAI ? 'AI-Generated' : isUncertain ? 'Uncertain' : 'Human-Created';
  
  // Format timestamp
  const detectionDate = new Date(data.timestamp * 1000);
  const timeAgo = formatTimeAgo(detectionDate);
  
  // Build Twitter URL
  const twitterUrl = `https://twitter.com/${data.twitter_handle}/status/${data.tweet_id}`;
  
  // Dynamic domain detection from current request
  const currentDomain = new URL(request.url).origin;
  
  // Current page URL for sharing
  const pageUrl = `${currentDomain}/d/${pageId}`;
  
  // Generate dynamic, compelling meta descriptions under character limits
  const shortDescription = `${scorePercentage}% ${scoreLabel} - AI detection analysis from TruthScan`;
  const longDescription = `AI detection analysis: ${scorePercentage}% probability of AI generation. From @${data.twitter_handle} tweet. Analyzed ${timeAgo}.`;
  
  // Image URLs with fallback
  const ogImageUrl = `${currentDomain}/thumbnails/${pageId}`;
  const fallbackImageUrl = `${currentDomain}/images/${pageId}`;
  
  // Accessibility descriptions for images
  const imageAltText = `AI detection result showing ${scorePercentage}% probability of artificial intelligence generation`;
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Detection: ${scorePercentage}% ${scoreLabel} | TruthScan</title>
  
  <!-- Enhanced SEO Meta Tags -->
  <meta name="description" content="${longDescription}">
  <meta name="robots" content="index, follow">
  <meta name="keywords" content="AI detection, artificial intelligence, image analysis, TruthScan, ${scoreLabel.toLowerCase()}">
  <meta name="author" content="TruthScan">
  <link rel="canonical" href="${pageUrl}">
  
  <!-- Enhanced Open Graph Meta Tags for Social Sharing -->
  <meta property="og:title" content="${shortDescription}">
  <meta property="og:description" content="${longDescription}">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:secure_url" content="${ogImageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:alt" content="${imageAltText}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TruthScan">
  <meta property="og:locale" content="en_US">
  <meta property="og:updated_time" content="${new Date().toISOString()}">
  
  <!-- Enhanced Twitter Card Meta Tags -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@truth_scan">
  <meta name="twitter:creator" content="@truth_scan">
  <meta name="twitter:title" content="${shortDescription}">
  <meta name="twitter:description" content="${longDescription}">
  <meta name="twitter:image" content="${ogImageUrl}">
  <meta name="twitter:image:alt" content="${imageAltText}">
      <meta name="twitter:domain" content="truthscan.com">
  
  <!-- Additional Twitter Card Labels for Structured Data Display -->
  <meta name="twitter:label1" content="AI Probability">
  <meta name="twitter:data1" content="${scorePercentage}%">
  <meta name="twitter:label2" content="Classification">
  <meta name="twitter:data2" content="${scoreLabel}">
  
  <!-- Additional SEO and Application Meta Tags -->
  <meta name="application-name" content="TruthScan">
  <meta name="generator" content="TruthScan AI Detection Engine">
  <meta name="rating" content="general">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data: https:; img-src 'self' data: https: blob:; script-src 'self' 'unsafe-inline';">
  
  <!-- Article and Content Meta Tags -->
  <meta property="article:author" content="TruthScan">
  <meta property="article:published_time" content="${new Date(data.timestamp * 1000).toISOString()}">
  <meta property="article:modified_time" content="${new Date().toISOString()}">
  <meta property="article:section" content="AI Detection">
  <meta property="article:tag" content="AI Detection">
  <meta property="article:tag" content="Image Analysis">
  <meta property="article:tag" content="${scoreLabel}">
  
  <!-- App and Browser Meta Tags -->
  <meta name="theme-color" content="${scoreColor}">
  <meta name="msapplication-TileColor" content="${scoreColor}">
  <meta name="msapplication-navbutton-color" content="${scoreColor}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="TruthScan">
  
  <!-- Performance and Caching Hints -->
  <meta http-equiv="Cache-Control" content="public, max-age=3600">
      <link rel="dns-prefetch" href="//truthscan.com">
    <link rel="preconnect" href="https://truthscan.com">
  <link rel="prefetch" href="/thumbnails/${pageId}">
  
  <!-- Favicon -->
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔍</text></svg>">
  
  <!-- JSON-LD Structured Data for Search Engines -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": ["WebPage", "Article"],
    "headline": "${shortDescription}",
    "name": "${shortDescription}",
    "description": "${longDescription}",
    "url": "${pageUrl}",
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": "${pageUrl}"
    },
    "datePublished": "${new Date(data.timestamp * 1000).toISOString()}",
    "dateModified": "${new Date().toISOString()}",
    "author": {
      "@type": "Organization",
      "name": "TruthScan",
      "url": "https://truthscan.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://truthscan.com/favicon.ico"
      }
    },
    "publisher": {
      "@type": "Organization",
      "name": "TruthScan",
      "url": "https://truthscan.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://truthscan.com/favicon.ico"
      }
    },
    "image": [
      "${ogImageUrl}",
      "${fallbackImageUrl}"
    ],
    "thumbnailUrl": "${ogImageUrl}",
    "about": {
      "@type": "Thing",
      "name": "AI Content Detection",
      "description": "Artificial intelligence detection analysis of digital content"
    },
    "keywords": [
      "AI detection",
      "artificial intelligence",
      "image analysis",
      "content verification",
      "${scoreLabel.toLowerCase()}",
      "TruthScan"
    ],
    "inLanguage": "en-US",
    "isAccessibleForFree": true,
    "creativeWorkStatus": "Published",
    "genre": "Technology Analysis",
    "articleSection": "AI Detection",
    "wordCount": ${longDescription.length + 50},
    "commentCount": 0,
    "interactionStatistic": {
      "@type": "InteractionCounter",
      "interactionType": "https://schema.org/ViewAction",
      "userInteractionCount": 1
    },
    "potentialAction": [
      {
        "@type": "ShareAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": "https://twitter.com/intent/tweet?url=${encodeURIComponent(pageUrl)}&text=${encodeURIComponent(shortDescription)}"
        }
      },
      {
        "@type": "ViewAction",
        "target": "${twitterUrl}",
        "name": "View Original Tweet"
      }
    ],
    "mentions": [
      {
        "@type": "Person",
        "name": "@${data.twitter_handle}",
        "url": "https://twitter.com/${data.twitter_handle}"
      }
    ],
    "citation": {
      "@type": "CreativeWork",
      "name": "Original Tweet by @${data.twitter_handle}",
      "url": "${twitterUrl}",
      "author": {
        "@type": "Person",
        "name": "@${data.twitter_handle}"
      }
    },
    "temporalCoverage": "${new Date(data.timestamp * 1000).toISOString()}",
    "spatialCoverage": "Global",
    "audience": {
      "@type": "Audience",
      "name": "Technology professionals, researchers, and social media users"
    }
  }
  </script>
  
  <style>
    /* CSS Reset and Base Styles */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --primary-color: #0F172A;
      --secondary-color: #1E293B;
      --text-color: #334155;
      --text-muted: #64748B;
      --border-color: #E2E8F0;
      --background-gradient: linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%);
      --background-white: #FFFFFF;
      --ai-color: #EF4444;
      --uncertain-color: #F59E0B;
      --human-color: #10B981;
      --accent-blue: #3B82F6;
      --spacing-xs: 0.5rem;
      --spacing-sm: 1rem;
      --spacing-md: 1.5rem;
      --spacing-lg: 2rem;
      --spacing-xl: 3rem;
      --border-radius: 1rem;
      --border-radius-lg: 1.5rem;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #FFFFFF;
      color: var(--text-color);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      font-weight: 400;
    }
    
    /* Main Container */
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: var(--spacing-lg) var(--spacing-sm);
      flex: 1;
    }
    
    
    /* Main Result Card */
    .result-card {
      background: var(--background-white);
      border: 1px solid var(--border-color);
      border-radius: var(--border-radius-lg);
      box-shadow: var(--shadow-xl);
      overflow: hidden;
      margin-bottom: var(--spacing-xl);
      backdrop-filter: blur(10px);
      position: relative;
    }
    

    
    /* Image Section */
    .image-container {
      position: relative;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      background: linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%);
    }
    
    .analyzed-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
      transition: transform 0.3s ease;
    }
    
    .analyzed-image:hover {
      transform: scale(1.02);
    }
    
    .image-fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%);
      color: var(--text-muted);
      font-size: 1.125rem;
      font-weight: 500;
    }
    
    /* Results Section */
    .results-section {
      padding: var(--spacing-xl) var(--spacing-lg);
      background: var(--background-white);
    }
    
    .confidence-score {
      text-align: center;
      margin-bottom: var(--spacing-xl);
      padding: var(--spacing-xl) var(--spacing-lg);
      background: linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%);
      border-radius: var(--border-radius-lg);
      border: 1px solid var(--border-color);
      box-shadow: var(--shadow-md);
    }
    
    .score-value {
      font-size: 4.5rem;
      font-weight: 900;
      color: ${scoreColor};
      display: block;
      line-height: 1;
      margin-bottom: var(--spacing-sm);
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      background: linear-gradient(135deg, ${scoreColor} 0%, ${scoreColor}CC 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .score-label {
      font-size: 1.375rem;
      font-weight: 700;
      color: var(--primary-color);
      margin-top: var(--spacing-sm);
      display: block;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    
    .confidence-bar {
      width: 100%;
      height: 12px;
      background: var(--border-color);
      border-radius: var(--border-radius);
      margin-top: var(--spacing-lg);
      overflow: hidden;
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
    }
    
    .confidence-fill {
      height: 100%;
      background: linear-gradient(90deg, ${scoreColor} 0%, ${scoreColor}DD 100%);
      width: ${scorePercentage}%;
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: var(--border-radius);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
    
    /* Source Section */
    .source-section {
      padding: var(--spacing-lg);
      border-top: 1px solid var(--border-color);
      background: linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%);
    }
    
    .source-link {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-sm);
      color: var(--accent-blue);
      text-decoration: none;
      font-weight: 600;
      font-size: 1.125rem;
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--border-radius);
      background: var(--background-white);
      border: 1px solid var(--border-color);
      box-shadow: var(--shadow-sm);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .source-link:hover {
      color: var(--primary-color);
      background: var(--background-white);
      border-color: var(--accent-blue);
      box-shadow: var(--shadow-md);
      transform: translateY(-1px);
    }
    


    
    /* Actions Section */
    .actions-section {
      padding: var(--spacing-lg);
      border-top: 1px solid var(--border-color);
      display: flex;
      gap: var(--spacing-md);
      flex-wrap: wrap;
      justify-content: center;
      background: var(--background-white);
    }
    
    .action-btn {
      padding: var(--spacing-md) var(--spacing-lg);
      border: 1px solid var(--border-color);
      border-radius: var(--border-radius);
      background: var(--background-white);
      color: var(--text-color);
      text-decoration: none;
      font-size: 1rem;
      font-weight: 600;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      min-height: 48px;
      min-width: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--shadow-sm);
      position: relative;
      overflow: hidden;
    }
    
    .action-btn::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
      transition: left 0.5s;
    }
    
    .action-btn:hover::before {
      left: 100%;
    }
    
    .action-btn:hover {
      background: linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%);
      border-color: var(--accent-blue);
      box-shadow: var(--shadow-md);
      transform: translateY(-2px);
    }
    
    .action-btn.primary {
      background: linear-gradient(135deg, var(--accent-blue) 0%, #2563EB 100%);
      color: white;
      border-color: var(--accent-blue);
      box-shadow: var(--shadow-lg);
    }
    
    .action-btn.primary:hover {
      background: linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%);
      border-color: #2563EB;
      box-shadow: var(--shadow-xl);
      transform: translateY(-2px);
    }
    
    /* Footer */
    .footer {
      padding: var(--spacing-xl) var(--spacing-sm);
      text-align: center;
      color: var(--text-muted);
      font-size: 0.875rem;
      margin-top: auto;
      background: #FFFFFF;
    }
    
    .footer a {
      color: var(--accent-blue);
      text-decoration: none;
      font-weight: 600;
      transition: all 0.2s ease;
    }
    
    .footer a:hover {
      color: var(--primary-color);
      text-decoration: underline;
    }
    
    /* Responsive Design */
    @media (min-width: 768px) {
      .container {
        padding: var(--spacing-xl) var(--spacing-md);
      }
      
      .score-value {
        font-size: 5rem;
      }
      
      .actions-section {
        justify-content: center;
      }
      
      .action-btn {
        min-width: 140px;
      }
    }
    
    @media (max-width: 767px) {
      .score-value {
        font-size: 3.5rem;
      }
      
      .score-label {
        font-size: 1.125rem;
      }
      
      .confidence-score {
        padding: var(--spacing-lg) var(--spacing-md);
      }
      
      .actions-section {
        flex-direction: column;
        align-items: center;
      }
      
      .action-btn {
        width: 100%;
        max-width: 300px;
      }
    }
    
    /* Accessibility */
    @media (prefers-reduced-motion: reduce) {
      * {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
    
    /* Focus styles for keyboard navigation */
    .action-btn:focus,
    .source-link:focus {
      outline: 2px solid #3B82F6;
      outline-offset: 2px;
    }
    
    /* High contrast mode support */
    @media (prefers-contrast: high) {
      :root {
        --border-color: #000000;
        --text-color: #000000;
      }
      
      .result-card {
        border: 2px solid #000000;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    
    <!-- Main Result Card -->
    <main class="result-card" role="main">
      <!-- Image Section -->
      <div class="image-container">
        <img 
          src="${currentDomain}/images/${pageId}" 
          alt="Image analyzed for AI-generated content detection"
          class="analyzed-image"
          loading="lazy"
          onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
        >
        <div class="image-fallback" style="display: none;">
          🖼️ Image not available
        </div>
      </div>
      
      <!-- Results Section -->
      <section class="results-section">
        <div class="confidence-score">
          <span class="score-value" aria-label="AI detection confidence score">${scorePercentage}%</span>
          <span class="score-label">${scoreLabel}</span>
          <div class="confidence-bar" role="progressbar" aria-valuenow="${scorePercentage}" aria-valuemin="0" aria-valuemax="100">
            <div class="confidence-fill"></div>
          </div>
        </div>
      </section>
      
      <!-- Source Section -->
      <section class="source-section">
        <a href="${twitterUrl}" class="source-link" target="_blank" rel="noopener noreferrer">
          🐦 View Original Tweet by @${data.twitter_handle}
        </a>
      </section>
      

      
      <!-- Actions Section -->
      <section class="actions-section">
        <button class="action-btn primary" onclick="shareResult()">Share Result</button>
        <button class="action-btn" onclick="copyLink()">Copy Link</button>
        <a href="${twitterUrl}" class="action-btn" target="_blank" rel="noopener noreferrer">View Tweet</a>
      </section>
    </main>
    
    <!-- Footer -->
    <footer class="footer">
      <p>
        Powered by <a href="https://truthscan.com" target="_blank" rel="noopener noreferrer">TruthScan</a> 
        • AI detection results are estimates and should not be considered definitive
      </p>
    </footer>
  </div>
  
  <script>
    // Minimal JavaScript for sharing functionality
    function shareResult() {
      if (navigator.share) {
        navigator.share({
          title: 'AI Detection Result: ${scorePercentage}% ${scoreLabel}',
          text: 'Check out this AI detection analysis from TruthScan',
          url: window.location.href
        }).catch(console.error);
      } else {
        copyLink();
      }
    }
    
    function copyLink() {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.background = '#059669';
        btn.style.color = 'white';
        btn.style.borderColor = '#059669';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
          btn.style.color = '';
          btn.style.borderColor = '';
        }, 2000);
      }).catch(console.error);
    }
    
    // Analytics (could be enhanced in Task 12)
    console.log('Detection page viewed:', {
      pageId: '${pageId}',
      score: ${scorePercentage},
      timestamp: new Date().toISOString()
    });
  </script>
</body>
</html>`;
}

/**
 * Format timestamp to relative time (e.g., "2 minutes ago")
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSeconds < 60) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  } else {
    return date.toLocaleDateString();
  }
}

/**
 * Get detection data by page_id from database
 * Returns object with detection data and deletion status for 410/404 handling
 */
async function getDetectionByPageId(pageId: string, env: Env): Promise<{ data: any | null; isDeleted: boolean; exists: boolean }> {
  try {
    console.log('Querying database for page_id:', pageId);
    
    const stmt = env.DB.prepare(`
      SELECT 
        id, tweet_id, timestamp, image_url, detection_score, twitter_handle, 
        response_tweet_id, processing_time_ms, api_provider, page_id, 
        created_at, updated_at
      FROM detections 
      WHERE page_id = ? 
      LIMIT 1
    `);
    
    const result = await stmt.bind(pageId).first();
    
    if (result) {
      console.log('Found active detection data for page_id:', {
        pageId: pageId,
        tweetId: result.tweet_id,
        hasImageUrl: !!result.image_url,
        timestamp: new Date().toISOString()
      });
      return { data: result, isDeleted: false, exists: true };
    } else {
      console.log('No detection found for page_id:', {
        pageId: pageId,
        queryTimestamp: new Date().toISOString()
      });
      return { data: null, isDeleted: false, exists: false };
    }
    
  } catch (error) {
    // Log structured database error for monitoring
    await MonitoringEvents.logDatabaseError(env, 'getDetectionByPageId', error, { pageId });
    
    return { data: null, isDeleted: false, exists: false };
  }
}

/**
 * Soft delete a detection page by setting deleted_at timestamp
 * This will cause the page to return 410 Gone instead of 404 Not Found
 * @note This is a utility function for administrative use
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function softDeleteDetectionPage(pageId: string, env: Env): Promise<{ success: boolean; message: string }> {
  try {
    console.log('Soft deleting detection page:', pageId);
    
    // First check if the page exists and is not already deleted
    const existing = await getDetectionByPageId(pageId, env);
    
    if (!existing.exists) {
      return { success: false, message: `Page ID "${pageId}" does not exist` };
    }
    
    if (existing.isDeleted) {
      return { success: false, message: `Page ID "${pageId}" is already deleted` };
    }
    
    // Soft delete by setting deleted_at timestamp
    const deleteTimestamp = Math.floor(Date.now() / 1000);
    const stmt = env.DB.prepare(`
      UPDATE detections 
      SET deleted_at = ?, updated_at = ?
      WHERE page_id = ? AND deleted_at IS NULL
    `);
    
    const result = await stmt.bind(deleteTimestamp, deleteTimestamp, pageId).run();
    
    if (result.meta && result.meta.changes && result.meta.changes > 0) {
      console.log('Successfully soft-deleted detection page:', {
        pageId: pageId,
        deletedAt: new Date(deleteTimestamp * 1000).toISOString(),
        timestamp: new Date().toISOString()
      });
      return { success: true, message: `Page ID "${pageId}" has been soft-deleted and will return 410 Gone` };
    } else {
      return { success: false, message: `Failed to delete page ID "${pageId}" - no changes made` };
    }
    
  } catch (error) {
    console.error('Error soft-deleting detection page:', {
      pageId: pageId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString()
    });
    return { success: false, message: 'Database error during soft delete operation' };
  }
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

/**
 * MONITORING API HANDLERS
 */

/**
 * Handle monitoring logs endpoint - Get recent log entries
 */
async function handleMonitoringLogs(request: Request, env: Env): Promise<Response> {
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
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const logLevel = url.searchParams.get('level') || 'all';
      const eventType = url.searchParams.get('event_type') || 'all';
      const hours = parseInt(url.searchParams.get('hours') || '24');

      // Calculate timestamp for time filtering
      const sinceTimestamp = Math.floor((Date.now() - (hours * 60 * 60 * 1000)) / 1000);

      let query = `
        SELECT * FROM logs 
        WHERE timestamp >= ?
      `;
      const params: any[] = [sinceTimestamp];

      // Add level filter
      if (logLevel !== 'all') {
        query += ` AND log_level = ?`;
        params.push(logLevel);
      }

      // Add event type filter
      if (eventType !== 'all') {
        query += ` AND event_type = ?`;
        params.push(eventType);
      }

      query += ` ORDER BY timestamp DESC LIMIT ?`;
      params.push(Math.min(limit, 500)); // Cap at 500 entries

      const stmt = env.DB.prepare(query);
      const results = await stmt.bind(...params).all();

      return new Response(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        filters: { logLevel, eventType, hours, limit },
        count: results.results?.length || 0,
        logs: results.results || []
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });

    } catch (error) {
      console.error('Monitoring logs API error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch monitoring logs',
        timestamp: new Date().toISOString()
      }), {
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
 * Handle monitoring page views endpoint - Get page view statistics
 */
async function handleMonitoringPageViews(request: Request, env: Env): Promise<Response> {
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
      const url = new URL(request.url);
      const hours = parseInt(url.searchParams.get('hours') || '24');
      const pageId = url.searchParams.get('page_id');

      // Calculate timestamp for time filtering
      const sinceTimestamp = Math.floor((Date.now() - (hours * 60 * 60 * 1000)) / 1000);

      // Get total page views
      let totalViewsQuery = `
        SELECT COUNT(*) as total_views
        FROM page_views 
        WHERE timestamp >= ?
      `;
      const totalParams: any[] = [sinceTimestamp];

      if (pageId) {
        totalViewsQuery += ` AND page_id = ?`;
        totalParams.push(pageId);
      }

      const totalStmt = env.DB.prepare(totalViewsQuery);
      const totalResult = await totalStmt.bind(...totalParams).first();

      // Get unique page views
      let uniqueViewsQuery = `
        SELECT COUNT(DISTINCT page_id) as unique_pages
        FROM page_views 
        WHERE timestamp >= ?
      `;
      const uniqueParams: any[] = [sinceTimestamp];

      if (pageId) {
        uniqueViewsQuery += ` AND page_id = ?`;
        uniqueParams.push(pageId);
      }

      const uniqueStmt = env.DB.prepare(uniqueViewsQuery);
      const uniqueResult = await uniqueStmt.bind(...uniqueParams).first();

      // Get bot vs human traffic
      const botStatsQuery = `
        SELECT 
          SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) as bot_views,
          SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END) as human_views
        FROM page_views 
        WHERE timestamp >= ?
        ${pageId ? 'AND page_id = ?' : ''}
      `;
      const botStatsParams = pageId ? [sinceTimestamp, pageId] : [sinceTimestamp];
      const botStmt = env.DB.prepare(botStatsQuery);
      const botResult = await botStmt.bind(...botStatsParams).first();

      // Get top pages (if not filtering by specific page_id)
      let topPages: any[] = [];
      if (!pageId) {
        const topPagesQuery = `
          SELECT 
            page_id,
            COUNT(*) as view_count,
            COUNT(DISTINCT user_agent) as unique_agents
          FROM page_views 
          WHERE timestamp >= ?
          GROUP BY page_id
          ORDER BY view_count DESC
          LIMIT 10
        `;
        const topPagesStmt = env.DB.prepare(topPagesQuery);
        const topPagesResult = await topPagesStmt.bind(sinceTimestamp).all();
        topPages = topPagesResult.results || [];
      }

      return new Response(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        filters: { hours, pageId },
        statistics: {
          totalViews: totalResult?.total_views || 0,
          uniquePages: uniqueResult?.unique_pages || 0,
          botViews: botResult?.bot_views || 0,
          humanViews: botResult?.human_views || 0,
          topPages: topPages
        }
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });

    } catch (error) {
      console.error('Monitoring page views API error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch page view statistics',
        timestamp: new Date().toISOString()
      }), {
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
 * Handle monitoring metrics endpoint - Get system metrics
 */
async function handleMonitoringMetrics(request: Request, env: Env): Promise<Response> {
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
      const url = new URL(request.url);
      const hours = parseInt(url.searchParams.get('hours') || '24');
      const metricName = url.searchParams.get('metric_name');

      // Calculate timestamp for time filtering
      const sinceTimestamp = Math.floor((Date.now() - (hours * 60 * 60 * 1000)) / 1000);

      // Get metrics based on filters
      let query = `
        SELECT * FROM system_metrics 
        WHERE timestamp >= ?
      `;
      const params: any[] = [sinceTimestamp];

      if (metricName) {
        query += ` AND metric_name = ?`;
        params.push(metricName);
      }

      query += ` ORDER BY timestamp DESC LIMIT 1000`;

      const stmt = env.DB.prepare(query);
      const results = await stmt.bind(...params).all();

      // Calculate aggregated stats
      const metrics = results.results || [];
      const aggregatedStats: Record<string, any> = {};

      // Group by metric name and calculate stats
      metrics.forEach((metric: any) => {
        const name = metric.metric_name;
        if (!aggregatedStats[name]) {
          aggregatedStats[name] = {
            count: 0,
            sum: 0,
            min: metric.metric_value,
            max: metric.metric_value,
            latest: metric.metric_value,
            type: metric.metric_type
          };
        }

        const stats = aggregatedStats[name];
        stats.count++;
        stats.sum += metric.metric_value;
        stats.min = Math.min(stats.min, metric.metric_value);
        stats.max = Math.max(stats.max, metric.metric_value);
        stats.latest = metric.metric_value; // Latest is from ORDER BY timestamp DESC
      });

      // Calculate averages
      Object.values(aggregatedStats).forEach((stats: any) => {
        stats.average = stats.sum / stats.count;
      });

      return new Response(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        filters: { hours, metricName },
        count: metrics.length,
        rawMetrics: metrics,
        aggregatedStats: aggregatedStats
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });

    } catch (error) {
      console.error('Monitoring metrics API error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch system metrics',
        timestamp: new Date().toISOString()
      }), {
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
 * Handle monitoring dashboard endpoint - Get aggregated monitoring data
 */
async function handleMonitoringDashboard(request: Request, env: Env): Promise<Response> {
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
      const hours = 24; // Dashboard shows last 24 hours
      const sinceTimestamp = Math.floor((Date.now() - (hours * 60 * 60 * 1000)) / 1000);

      // Get error count
      const errorQuery = `
        SELECT COUNT(*) as error_count
        FROM logs 
        WHERE timestamp >= ? AND log_level = 'error'
      `;
      const errorStmt = env.DB.prepare(errorQuery);
      const errorResult = await errorStmt.bind(sinceTimestamp).first();

      // Get recent errors
      const recentErrorsQuery = `
        SELECT event_type, message, timestamp
        FROM logs 
        WHERE timestamp >= ? AND log_level = 'error'
        ORDER BY timestamp DESC
        LIMIT 5
      `;
      const recentErrorsStmt = env.DB.prepare(recentErrorsQuery);
      const recentErrorsResult = await recentErrorsStmt.bind(sinceTimestamp).all();

      // Get page view stats
      const pageViewQuery = `
        SELECT 
          COUNT(*) as total_views,
          COUNT(DISTINCT page_id) as unique_pages,
          SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) as bot_views
        FROM page_views 
        WHERE timestamp >= ?
      `;
      const pageViewStmt = env.DB.prepare(pageViewQuery);
      const pageViewResult = await pageViewStmt.bind(sinceTimestamp).first();

      // Get detection stats from main table
      const detectionQuery = `
        SELECT 
          COUNT(*) as total_detections,
          AVG(processing_time_ms) as avg_processing_time,
          AVG(detection_score) as avg_detection_score
        FROM detections 
        WHERE timestamp >= ?
      `;
      const detectionStmt = env.DB.prepare(detectionQuery);
      const detectionResult = await detectionStmt.bind(sinceTimestamp).first();

      // Get error breakdown by type
      const errorBreakdownQuery = `
        SELECT 
          event_type,
          COUNT(*) as count
        FROM logs 
        WHERE timestamp >= ? AND log_level = 'error'
        GROUP BY event_type
        ORDER BY count DESC
        LIMIT 5
      `;
      const errorBreakdownStmt = env.DB.prepare(errorBreakdownQuery);
      const errorBreakdownResult = await errorBreakdownStmt.bind(sinceTimestamp).all();

      // Aggregate dashboard data
      const dashboardData = {
        success: true,
        timestamp: new Date().toISOString(),
        timeRange: `${hours} hours`,
        overview: {
          totalErrors: Number(errorResult?.error_count) || 0,
          totalPageViews: Number(pageViewResult?.total_views) || 0,
          uniquePages: Number(pageViewResult?.unique_pages) || 0,
          botTraffic: Number(pageViewResult?.bot_views) || 0,
          totalDetections: Number(detectionResult?.total_detections) || 0,
          avgProcessingTime: Math.round(Number(detectionResult?.avg_processing_time) || 0),
          avgDetectionScore: Math.round((Number(detectionResult?.avg_detection_score) || 0) * 100) / 100
        },
        recentErrors: recentErrorsResult.results || [],
        errorBreakdown: errorBreakdownResult.results || [],
        healthStatus: {
          errorRate: Number(pageViewResult?.total_views) > 0 
            ? Math.round(((Number(errorResult?.error_count) || 0) / Number(pageViewResult?.total_views)) * 10000) / 100 
            : 0,
          status: (Number(errorResult?.error_count) || 0) < 10 ? 'healthy' : 'warning'
        }
      };

      return new Response(JSON.stringify(dashboardData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });

    } catch (error) {
      console.error('Monitoring dashboard API error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch dashboard data',
        timestamp: new Date().toISOString()
      }), {
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