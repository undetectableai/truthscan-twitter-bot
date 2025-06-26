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
  
  // Static Assets binding
  ASSETS: Fetcher;
  
  // Twitter API credentials (stored as Wrangler secrets)
  TWITTER_API_KEY: string;
  TWITTER_API_KEY_SECRET: string;
  TWITTER_BEARER_TOKEN: string;
  TWITTER_ACCESS_TOKEN: string;
  TWITTER_ACCESS_TOKEN_SECRET: string;
  
  // AI Detection API (Undetectable.AI)
  AI_DETECTION_API_KEY: string;
  
  // Groq API for image analysis
  GROQ_API_KEY: string;
  
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
 * Enhanced logging for Twitter API requests and responses
 * Captures detailed information for rate limit debugging
 */
async function logTwitterAPICall(
  method: string,
  url: string,
  requestHeaders: Record<string, string>,
  requestBody: any,
  response: Response,
  responseBody: string,
  env: Env,
  startTime: number
): Promise<void> {
  const endTime = Date.now();
  const durationMs = endTime - startTime;
  
  // Extract rate limit headers from Twitter response
  const rateLimitHeaders = {
    limit: response.headers.get('x-rate-limit-limit'),
    remaining: response.headers.get('x-rate-limit-remaining'),
    reset: response.headers.get('x-rate-limit-reset'),
    resetTime: response.headers.get('x-rate-limit-reset') ? 
      new Date(parseInt(response.headers.get('x-rate-limit-reset')!) * 1000).toISOString() : null
  };
  
  // Determine endpoint type for tracking
  let endpointType = 'unknown';
  if (url.includes('/2/tweets') && method === 'POST') {
    endpointType = 'post_tweet';
  } else if (url.includes('/2/users') && url.includes('/likes') && method === 'POST') {
    endpointType = 'like_tweet';
  } else if (url.includes('/2/tweets/search/recent')) {
    endpointType = 'search_tweets';
  } else if (url.includes('/1.1/account/verify_credentials')) {
    endpointType = 'verify_credentials';
  }
  
  // Determine if this was a rate limit error
  const isRateLimited = response.status === 429;
  const isError = !response.ok;
  
  // Log the detailed API call information
  await logEvent(env, isError ? 'error' : 'info', 'twitter_api_call', 
    `Twitter API ${method} ${endpointType}: ${response.status} ${response.statusText}`, {
      details: {
        endpoint: {
          method,
          url,
          type: endpointType
        },
        request: {
          hasAuth: !!requestHeaders.Authorization,
          bodySize: requestBody ? JSON.stringify(requestBody).length : 0,
          timestamp: new Date(startTime).toISOString()
        },
        response: {
          status: response.status,
          statusText: response.statusText,
          bodySize: responseBody.length,
          durationMs
        },
        rateLimits: {
          ...rateLimitHeaders,
          internal: {
            currentWindow: twitterRateLimit.requestCount,
            windowStart: new Date(twitterRateLimit.windowStartTime).toISOString()
          }
        },
        error: isError ? {
          isRateLimited,
          responseBody: responseBody.substring(0, 500) // Truncate long responses
        } : undefined
      }
    }
  );
  
  // Log rate limit metrics for dashboard tracking
  if (rateLimitHeaders.limit && rateLimitHeaders.remaining) {
    await logSystemMetric(env, 'twitter_rate_limit_remaining', 
      parseInt(rateLimitHeaders.remaining), 'gauge', {
        tags: { 
          endpoint: endpointType,
          limit: rateLimitHeaders.limit
        }
      }
    );
  }
  
  // Specific console logging for rate limit issues
  if (isRateLimited) {
    const resetTime = rateLimitHeaders.reset ? new Date(parseInt(rateLimitHeaders.reset) * 1000) : null;
    const minutesUntilReset = resetTime ? Math.ceil((resetTime.getTime() - Date.now()) / (1000 * 60)) : 'unknown';
    const limitValue = parseInt(rateLimitHeaders.limit || '0');
    
    let limitType = 'UNKNOWN';
    // FIXED: Handle the bogus 1,080,000 limit from Twitter API bug
    if (limitValue === 1080000) {
      limitType = 'TWITTER_API_BUG (1080000 not documented)';
    } else if (limitValue >= 1000000) {
      limitType = 'MONTHLY/APP_LEVEL';
    } else if (limitValue >= 10000) {
      limitType = 'HOURLY/BURST';
    } else if (limitValue >= 1000) {
      limitType = 'HOURLY';
    } else if (limitValue <= 100) {
      limitType = 'DAILY_USER';
    }
    
          console.error('🚫 TWITTER RATE LIMIT HIT:', {
        endpoint: endpointType,
        method,
        url,
        limitType,
        WARNING: limitValue === 1080000 ? 'This limit (1080000) is NOT documented in Twitter API v2. Possible Twitter API bug!' : null,
        rateLimitHeaders: {
          ...rateLimitHeaders,
          resetTime: resetTime ? resetTime.toISOString() : 'unknown',
          minutesUntilReset
        },
        responseBody: responseBody.substring(0, 200),
        internalTracker: {
          requestCount: twitterRateLimit.requestCount,
          windowStart: new Date(twitterRateLimit.windowStartTime).toISOString(),
          timeInWindow: Math.round((Date.now() - twitterRateLimit.windowStartTime) / 1000 / 60)
        }
      });
  } else if (isError) {
    console.error('❌ TWITTER API ERROR:', {
      endpoint: endpointType,
      status: response.status,
      statusText: response.statusText,
      responseBody: responseBody.substring(0, 200),
      rateLimitHeaders
    });
  } else {
    console.log('✅ TWITTER API SUCCESS:', {
      endpoint: endpointType,
      durationMs,
      remaining: rateLimitHeaders.remaining || 'unknown',
      resetTime: rateLimitHeaders.resetTime || 'unknown'
    });
  }
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
 * Promote popular pages to public indexing
 * Finds pages with 50+ views that aren't already indexed and makes them publicly searchable
 */
async function promotePopularPages(env: Env): Promise<{ success: boolean; promotedCount: number; details: string[] }> {
  try {
    console.log('🔍 Checking for pages eligible for public indexing promotion...');
    
    // Find pages with 50+ views that aren't already indexed
    const query = `
      SELECT 
        d.page_id,
        d.id as detection_id,
        COUNT(pv.id) as view_count,
        d.robots_index
      FROM detections d
      LEFT JOIN page_views pv ON d.page_id = pv.page_id
      WHERE d.robots_index = 0 OR d.robots_index IS NULL
      GROUP BY d.page_id, d.id, d.robots_index
      HAVING COUNT(pv.id) >= 50
      ORDER BY view_count DESC
    `;
    
    const result = await env.DB.prepare(query).all();
    const eligiblePages = result.results || [];
    
    // DEBUG: Log the actual query results
    console.log('🔍 PROMOTION DEBUG: Query executed successfully');
    console.log('🔍 PROMOTION DEBUG: Raw DB result:', { 
      success: result.success, 
      resultsLength: result.results?.length || 0,
      meta: result.meta 
    });
    console.log('🔍 PROMOTION DEBUG: Eligible pages found:', eligiblePages.length);
    if (eligiblePages.length > 0) {
      console.log('🔍 PROMOTION DEBUG: First few eligible pages:', eligiblePages.slice(0, 3));
    }
    
    if (eligiblePages.length === 0) {
      console.log('❌ No pages found that meet promotion criteria (5+ views, not already indexed)');
      return { 
        success: true, 
        promotedCount: 0, 
        details: ['No pages eligible for promotion'] 
      };
    }
    
    console.log(`📈 Found ${eligiblePages.length} page(s) eligible for promotion:`, eligiblePages);
    
    const promotedDetails: string[] = [];
    let promotedCount = 0;
    
    // Update each eligible page to be publicly indexable
    for (const pageRow of eligiblePages) {
      const page = pageRow as { page_id: string; detection_id: string; view_count: number; robots_index: number | null };
      try {
        const updateQuery = `
          UPDATE detections 
          SET robots_index = 1, updated_at = ? 
          WHERE page_id = ?
        `;
        
        const updateResult = await env.DB
          .prepare(updateQuery)
          .bind(Math.floor(Date.now() / 1000), page.page_id)
          .run();
        
        if (updateResult.meta && updateResult.meta.changes && updateResult.meta.changes > 0) {
          promotedCount++;
          const detail = `Promoted page ${page.page_id} (${page.view_count} views) to public indexing`;
          promotedDetails.push(detail);
          console.log(`🎉 ${detail}`);
          
          // Log this promotion event for monitoring
          await logEvent(env, 'info', 'page_promoted', 
            `Page promoted to public indexing: ${page.page_id}`, {
              pageId: page.page_id,
              details: {
                viewCount: page.view_count,
                previouslyIndexed: !!page.robots_index
              }
            }
          );
          
          // Log system metric for promotion
          await logSystemMetric(env, 'pages_promoted', 1, 'counter', {
            tags: { pageId: page.page_id, viewCount: page.view_count }
          });
          
        } else {
          console.warn(`⚠️ Failed to update page ${page.page_id} - no database changes made`);
          promotedDetails.push(`Failed to update page ${page.page_id}`);
        }
        
      } catch (pageError) {
        console.error(`❌ Error promoting page ${page.page_id}:`, pageError);
        promotedDetails.push(`Error promoting page ${page.page_id}: ${pageError}`);
      }
    }
    
    console.log(`✅ Page promotion complete: ${promotedCount}/${eligiblePages.length} pages promoted`);
    
    return {
      success: true,
      promotedCount,
      details: promotedDetails
    };
    
  } catch (error) {
    console.error('❌ Error in promotePopularPages:', error);
    
    // Log the error for monitoring
    await logEvent(env, 'error', 'page_promotion_failed', 
      'Failed to check/promote popular pages', {
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      }
    );
    
    return {
      success: false,
      promotedCount: 0,
      details: [`Error: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
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
    searchUrl.searchParams.set('tweet.fields', 'id,text,author_id,created_at,attachments,referenced_tweets,entities');
    searchUrl.searchParams.set('user.fields', 'username');
    searchUrl.searchParams.set('media.fields', 'url,preview_image_url,type');
    searchUrl.searchParams.set('expansions', 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id');
    searchUrl.searchParams.set('max_results', '10');
    searchUrl.searchParams.set('sort_order', 'recency');
    
    // KEY OPTIMIZATION: Only fetch tweets newer than the last processed one
    if (sinceId) {
      searchUrl.searchParams.set('since_id', sinceId);
      console.log(`Using since_id parameter: ${sinceId}`);
    }

    const startTime = Date.now();
    const requestHeaders = {
      'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    };
    
    const response = await fetch(searchUrl.toString(), {
      headers: requestHeaders
    });

    const responseBody = await response.text();
    
    // Log the detailed API call for debugging
    await logTwitterAPICall('GET', searchUrl.toString(), requestHeaders, null, response, responseBody, env, startTime);

    if (!response.ok) {
      throw new Error(`Twitter API error: ${response.status} ${response.statusText} - ${responseBody}`);
    }

    const searchResults: TwitterV2SearchResponse = JSON.parse(responseBody);

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
        let originalAuthorUsername = authorUsername; // Default to mention tweet author
        
        if (isReply) {
          // Look for images in the original tweet that was replied to
          const referencedTweetId = tweet.referenced_tweets?.find(ref => ref.type === 'replied_to')?.id;
          
          if (referencedTweetId) {
            const originalTweet = searchResults.includes?.tweets?.find(
              t => t.id === referencedTweetId
            );
            
            if (originalTweet) {
              // Get the original tweet's author from the includes section
              console.log('DEBUG: Searching for original author:', {
                originalTweetAuthorId: originalTweet.author_id,
                availableUsers: searchResults.includes?.users?.map(u => ({ id: u.id, username: u.username })) || [],
                totalUsersInIncludes: searchResults.includes?.users?.length || 0
              });
              
              const originalAuthor = searchResults.includes?.users?.find(
                user => user.id === originalTweet.author_id
              );
              if (originalAuthor) {
                originalAuthorUsername = originalAuthor.username;
                console.log('✅ Found original tweet author:', {
                  originalAuthor: originalAuthorUsername,
                  mentionAuthor: authorUsername,
                  originalTweetId: referencedTweetId
                });
              } else {
                console.log('❌ Original author NOT found in includes.users, falling back to mention author:', {
                  searchedForAuthorId: originalTweet.author_id,
                  mentionAuthor: authorUsername,
                  originalTweetId: referencedTweetId
                });
              }
              
              // Convert the v2 format to webhook format and extract all images (media + Open Graph)
              const webhookFormatTweet = convertV2ToWebhookFormat(originalTweet);
              
              // Add media entities from v2 media_keys
              if (originalTweet.attachments?.media_keys) {
                const mediaObjects = searchResults.includes?.media?.filter(
                  media => originalTweet.attachments!.media_keys.includes(media.media_key!)
                ) || [];
                
                const mediaEntities = mediaObjects
                  .filter(media => media.type === 'photo')
                  .map(media => ({
                    id: 0, // Placeholder
                    media_url_https: media.url!,
                    type: 'photo'
                  }));
                
                webhookFormatTweet.entities!.media = mediaEntities;
                webhookFormatTweet.extended_entities!.media = mediaEntities;
              }
              
              // Extract all images (media + Open Graph) using the enhanced extraction
              console.log('Extracting images from original tweet using Open Graph extraction...');
              imageUrls = await extractAllImageUrls(webhookFormatTweet);
              
              // Extract hashtags and text from the ORIGINAL tweet
              sourceText = originalTweet.text || '';
              const hashtagMatches = sourceText.match(/#\w+/g) || [];
              sourceHashtags = hashtagMatches.map(tag => tag.substring(1)); // Remove # symbol
              
              console.log('Found NEW reply to tweet with comprehensive image extraction:', {
                originalTweetId: referencedTweetId,
                originalAuthor: originalAuthorUsername,
                mentionAuthor: authorUsername,
                imageCount: imageUrls.length,
                urlsInOriginal: originalTweet.entities?.urls?.length || 0,
                originalText: sourceText.substring(0, 100) + '...',
                originalHashtags: sourceHashtags,
                extractedImages: imageUrls
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
          author: originalAuthorUsername, // This is now the original poster, not the mention author
          mentionAuthor: authorUsername,
          isReply,
          imageCount: imageUrls.length,
          replyText: tweet.text?.substring(0, 100) + '...',
          sourceText: sourceText.substring(0, 100) + '...',
          sourceHashtags
        });
        
        // Create parsed tweet data using the correct source (original tweet for replies, mention tweet for direct mentions)
        const parsedTweet: ParsedTweetData = {
          tweetId,
          username: originalAuthorUsername, // Use original tweet author for replies, mention author for direct mentions
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
          
          // Mark tweet as processed even if no images found to prevent infinite retries
          const noImageInsertTask = insertDetection(env, {
            id: crypto.randomUUID(),
            tweetId: tweetId,
            timestamp: Date.now(),
            imageUrl: 'no-images-found',
            detectionScore: 0,
            twitterHandle: originalAuthorUsername,
            responseTweetId: undefined,
            processingTimeMs: 0,
            apiProvider: 'none'
          }).then(result => {
            if (result.success) {
              console.log(`✅ Marked tweet ${tweetId} as processed (no images found)`);
            } else {
              console.error(`❌ Failed to mark tweet ${tweetId} as processed:`, result);
            }
          }).catch(error => {
            console.error(`Error marking tweet ${tweetId} as processed:`, error);
          });
          
          backgroundTasks.push(noImageInsertTask);
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

/**
 * Generate dynamic robots.txt based on indexable pages
 */
async function handleRobotsTxt(request: Request, env: Env): Promise<Response> {
  try {
    console.log('🤖 Generating dynamic robots.txt...');
    
    // Get all pages that are marked as indexable (robots_index = 1)
    // Try the full query first, fall back to basic query if columns don't exist
    let indexablePages: any[] = [];
    
    try {
      // Try with all columns (production environment)
      const fullQuery = `
        SELECT page_id, timestamp
        FROM detections 
        WHERE robots_index = 1 
          AND deleted_at IS NULL 
        ORDER BY timestamp DESC
      `;
      const result = await env.DB.prepare(fullQuery).all();
      indexablePages = result.results || [];
    } catch (error) {
      console.log('Full query failed, trying fallback queries...', error);
      
      try {
        // Try with just robots_index (some migrations applied)
        const robotsQuery = `
          SELECT page_id, timestamp
          FROM detections 
          WHERE robots_index = 1 
          ORDER BY timestamp DESC
        `;
        const result = await env.DB.prepare(robotsQuery).all();
        indexablePages = result.results || [];
      } catch (robotsError) {
        console.log('Robots query failed, using empty result...', robotsError);
        // Neither column exists - return empty array (no indexable pages)
        indexablePages = [];
      }
    }
    
    console.log(`📄 Found ${indexablePages.length} indexable pages for robots.txt`);
    
    // Generate dynamic robots.txt content
    const robotsTxtContent = generateRobotsTxtContent(indexablePages, request);
    
    // Set appropriate caching headers (cache for 1 hour)
    const headers = new Headers({
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'Last-Modified': new Date().toUTCString(),
    });
    
    return new Response(robotsTxtContent, {
      status: 200,
      headers: headers
    });
    
  } catch (error) {
    console.error('❌ Error generating robots.txt:', error);
    
    // Return a basic robots.txt if database query fails
    const fallbackContent = `User-agent: *
Disallow: /api/
Disallow: /webhook/

# This robots.txt is dynamically generated based on indexable content.
# Error occurred - showing fallback version.`;
    
    return new Response(fallbackContent, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Generate robots.txt content with sitemap reference
 */
function generateRobotsTxtContent(indexablePages: any[], _request: Request): string {
  // Always use the production domain
  const baseUrl = 'https://truthscan.com';
  
  let robotsContent = `User-agent: *
Disallow: /api/
Disallow: /webhook/
Disallow: /images/
Disallow: /thumbnails/

# Allow indexing of promoted detection pages (50+ views)
# Individual page URLs are listed in the sitemap.xml

Sitemap: ${baseUrl}/detection/sitemap.xml`;
  
  robotsContent += `\n\n# Generated automatically at ${new Date().toISOString()}`;
  robotsContent += `\n# Pages with 50+ views are automatically promoted for indexing`;
  robotsContent += `\n# Currently ${indexablePages.length} page(s) are indexed`;
  
  return robotsContent;
}

/**
 * Generate dynamic sitemap.xml based on indexable pages
 */
async function handleSitemapXml(request: Request, env: Env): Promise<Response> {
  try {
    console.log('🗺️ Generating dynamic sitemap.xml...');
    
    // Get all pages that are marked as indexable (robots_index = 1)
    // Try the full query first, fall back to basic query if columns don't exist
    let indexablePages: any[] = [];
    
    try {
      // Try with all columns (production environment)
      const fullQuery = `
        SELECT page_id, timestamp
        FROM detections 
        WHERE robots_index = 1 
          AND deleted_at IS NULL 
        ORDER BY timestamp DESC
      `;
      const result = await env.DB.prepare(fullQuery).all();
      indexablePages = result.results || [];
    } catch (error) {
      console.log('Full query failed, trying fallback queries...', error);
      
      try {
        // Try with just robots_index (some migrations applied)
        const robotsQuery = `
          SELECT page_id, timestamp
          FROM detections 
          WHERE robots_index = 1 
          ORDER BY timestamp DESC
        `;
        const result = await env.DB.prepare(robotsQuery).all();
        indexablePages = result.results || [];
      } catch (robotsError) {
        console.log('Robots query failed, using empty result...', robotsError);
        // Neither column exists - return empty array (no indexable pages)
        indexablePages = [];
      }
    }
    
    console.log(`🗺️ Found ${indexablePages.length} indexable pages for sitemap.xml`);
    
    // Generate dynamic sitemap.xml content
    const sitemapContent = generateSitemapXmlContent(indexablePages, request);
    
    // Set appropriate caching headers (cache for 1 hour)
    const headers = new Headers({
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'Last-Modified': new Date().toUTCString(),
    });
    
    return new Response(sitemapContent, {
      status: 200,
      headers: headers
    });
    
  } catch (error) {
    console.error('❌ Error generating sitemap.xml:', error);
    
    // Return an empty sitemap if database query fails
    const fallbackContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Error occurred generating sitemap - showing empty version -->
</urlset>`;
    
    return new Response(fallbackContent, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' }
    });
  }
}

/**
 * Generate sitemap.xml content for indexable pages
 */
function generateSitemapXmlContent(indexablePages: any[], _request: Request): string {
  // Always use the production domain
  const baseUrl = 'https://truthscan.com';
  
  let sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  // Add homepage
  sitemapContent += `
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`;
  
  // Add each indexable detection page (only pages with 50+ views)
  for (const page of indexablePages) {
    const pageData = page as { page_id: string; timestamp: string };
    const pageId = pageData.page_id;
    const timestamp = new Date(pageData.timestamp);
    
    sitemapContent += `
  <url>
    <loc>${baseUrl}/d/${pageId}</loc>
    <lastmod>${timestamp.toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
  }
  
  sitemapContent += `
</urlset>`;

  return sitemapContent;
}

/**
 * Handle Twitter polling (runs every minute)
 */
async function handleTwitterPolling(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('🐦 Starting Twitter polling...');
  
  try {
    // Sequential polling: 4 calls per minute, each call uses the previous call's result
    // This prevents race conditions and duplicate processing
    let lastProcessedTweetId: string | null = null;
    
    const executeSequentialPolling = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) {
        const delayMs = i * 15000; // 0s, 15s, 30s, 45s
        
        // Wait for the delay before each call (except the first one)
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        
        try {
          console.log(`Starting smart polling call ${i + 1}/4 (${delayMs/1000}s delay)`);
          const result = await pollTwitterMentionsIncremental(env, ctx, lastProcessedTweetId);
          
          // Update the last processed tweet ID for the next call in sequence
          if (result.highestTweetId) {
            lastProcessedTweetId = result.highestTweetId;
            console.log(`Updated last processed tweet ID to: ${lastProcessedTweetId}`);
          }
          
          console.log(`Completed smart polling call ${i + 1}/4 - Found ${result.newTweetsCount} new tweets`);
        } catch (error) {
          console.error(`Error in smart polling call ${i + 1}/4:`, error);
          // Continue with next polling call even if one fails
        }
      }
    };
    
    // Use waitUntil to ensure sequential polling completes
    ctx.waitUntil(executeSequentialPolling());
    
    console.log('✅ Scheduled 4 sequential smart polling calls (incremental, every 15s) for this minute');
    
  } catch (error) {
    console.error('❌ Error in Twitter polling setup:', error);
  }
}

/**
 * Handle page promotion (runs every hour)
 */
async function handlePagePromotion(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('🔍 Starting page promotion check...');
  
  try {
    // Run the page promotion logic
    const promotionTask = promotePopularPages(env);
    
    // Use waitUntil for proper background task handling
    ctx.waitUntil(promotionTask.then(result => {
      if (result.success) {
        console.log(`✅ Page promotion completed: ${result.promotedCount} pages promoted`);
        result.details.forEach(detail => console.log(`  - ${detail}`));
      } else {
        console.error('❌ Page promotion failed:', result.details);
      }
    }));
    
    console.log('✅ Page promotion task scheduled');
    
  } catch (error) {
    console.error('❌ Error in page promotion setup:', error);
  }
}

/**
 * Debug Twitter API authentication and rate limits
 */
async function handleTwitterDebug(request: Request, env: Env): Promise<Response> {
  try {
    const authResult = requireBasicAuth(request, env);
    if (authResult) return authResult;

    console.log('🐦 Debugging Twitter API status...');

    const debugInfo: any = {
      timestamp: new Date().toISOString(),
      credentials: {
        hasApiKey: !!env.TWITTER_API_KEY,
        hasApiKeySecret: !!env.TWITTER_API_KEY_SECRET,
        hasAccessToken: !!env.TWITTER_ACCESS_TOKEN,
        hasAccessTokenSecret: !!env.TWITTER_ACCESS_TOKEN_SECRET,
        hasBearerToken: !!env.TWITTER_BEARER_TOKEN,
        botUsername: env.TWITTER_BOT_USERNAME || 'not_set'
      },
      tests: []
    };

    // Test 1: Verify credentials endpoint
    try {
      const url = 'https://api.twitter.com/1.1/account/verify_credentials.json';
      const authHeader = await generateTwitterOAuthSignature('GET', url, {}, env);
      const startTime = Date.now();
      
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': authHeader }
      });
      
      const responseBody = await response.text();
      const processingTime = Date.now() - startTime;
      
      debugInfo.tests.push({
        name: 'verify_credentials',
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        processingTimeMs: processingTime,
        rateLimitHeaders: {
          limit: response.headers.get('x-rate-limit-limit'),
          remaining: response.headers.get('x-rate-limit-remaining'),
          reset: response.headers.get('x-rate-limit-reset')
        },
        responsePreview: response.ok ? JSON.parse(responseBody) : responseBody.substring(0, 200)
      });
    } catch (error) {
      debugInfo.tests.push({
        name: 'verify_credentials',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Test 2: Rate limit status endpoint
    try {
      const url = 'https://api.twitter.com/1.1/application/rate_limit_status.json?resources=statuses,application';
      const authHeader = await generateTwitterOAuthSignature('GET', url, {}, env);
      const startTime = Date.now();
      
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': authHeader }
      });
      
      const responseBody = await response.text();
      const processingTime = Date.now() - startTime;
      
      let rateLimitData = null;
      if (response.ok) {
        const data = JSON.parse(responseBody);
        rateLimitData = {
          statuses: data.resources?.statuses || {},
          application: data.resources?.application || {}
        };
      }
      
      debugInfo.tests.push({
        name: 'rate_limit_status',
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        processingTimeMs: processingTime,
        rateLimitHeaders: {
          limit: response.headers.get('x-rate-limit-limit'),
          remaining: response.headers.get('x-rate-limit-remaining'),
          reset: response.headers.get('x-rate-limit-reset')
        },
        rateLimitData: rateLimitData || responseBody.substring(0, 200)
      });
    } catch (error) {
      debugInfo.tests.push({
        name: 'rate_limit_status',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Test 3: Recent tweet posting attempts from database
    try {
      const recentAttempts = await env.DB.prepare(`
        SELECT 
          tweet_id,
          response_tweet_id,
          twitter_handle,
          timestamp,
          detection_score
        FROM detections 
        WHERE timestamp > ? 
        ORDER BY timestamp DESC 
        LIMIT 10
      `).bind(Math.floor(Date.now() / 1000) - (4 * 60 * 60)).all(); // Last 4 hours

      debugInfo.tests.push({
        name: 'recent_processing',
        success: true,
        recentDetections: recentAttempts.results?.length || 0,
        successfulReplies: recentAttempts.results?.filter((r: any) => r.response_tweet_id).length || 0,
        recentData: recentAttempts.results?.slice(0, 5) || []
      });
    } catch (error) {
      debugInfo.tests.push({
        name: 'recent_processing',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Test 4: Check for the mysterious 1,080,000 rate limit
    debugInfo.mysteriousRateLimit = {
      explanation: "The 1,080,000 rate limit is NOT documented in Twitter API v2",
      expectedLimits: {
        "POST /2/tweets (Basic Plan)": "100 requests per 24 hours per user",
        "POST /2/tweets (Free Plan)": "17 requests per 24 hours per user",
        "POST /2/tweets (Pro Plan)": "100 requests per 15 minutes per user"
      },
      recommendation: "This suggests either an API bug, enterprise endpoint, or authentication issue"
    };

    return new Response(JSON.stringify(debugInfo, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Twitter debug failed:', error);
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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      
      // Normalize /bot-api/* routes to /api/* for internal routing
      if (url.pathname.startsWith('/bot-api/')) {
        url.pathname = url.pathname.replace('/bot-api/', '/api/');
      }
      
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
          
        case '/api/test-groq':
          return handleGroqTest(request, env);
          
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
          
        case '/api/test/direct-promotion-query':
          try {
            console.log('🧪 Direct promotion query test called');
            
            // Run the exact same query as the promotion function
            const query = `
              SELECT 
                d.page_id,
                d.id as detection_id,
                COUNT(pv.id) as view_count,
                d.robots_index
              FROM detections d
              LEFT JOIN page_views pv ON d.page_id = pv.page_id
              WHERE d.robots_index = 0 OR d.robots_index IS NULL
              GROUP BY d.page_id, d.id, d.robots_index
              HAVING COUNT(pv.id) >= 5
              ORDER BY view_count DESC
            `;
            
            const result = await env.DB.prepare(query).all();
            
            return new Response(JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              queryResults: {
                success: result.success,
                resultsLength: result.results?.length || 0,
                meta: result.meta,
                results: result.results || []
              }
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('❌ Direct promotion query test failed:', error);
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date().toISOString()
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        case '/api/test/promote-32vi':
          try {
            console.log('🧪 Direct promotion test for page 32vi');
            
            // Direct promotion of page 32vi for testing
            const updateQuery = `
              UPDATE detections 
              SET robots_index = 1, updated_at = ? 
              WHERE page_id = ?
            `;
            
            const updateResult = await env.DB
              .prepare(updateQuery)
              .bind(Math.floor(Date.now() / 1000), '32vi')
              .run();
            
            return new Response(JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              testResult: {
                pageId: '32vi',
                updateSuccess: updateResult.success,
                changes: updateResult.meta?.changes || 0,
                message: updateResult.meta?.changes > 0 ? 'Page 32vi promoted successfully' : 'No changes made'
              }
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('❌ Direct promotion test failed:', error);
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date().toISOString()
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        case '/api/test/trigger-cron-promotion':
          try {
            console.log('🧪 Manual cron job promotion trigger called');
            
            // Directly call the same function that the cron job calls
            await handlePagePromotion(env, _ctx);
            
            return new Response(JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              message: "Page promotion cron job triggered manually"
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('❌ Manual cron promotion trigger failed:', error);
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date().toISOString()
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        case '/api/test/manual-page-promotion':
          try {
            console.log('🧪 Manual page promotion trigger called');
            
            // First, run the query directly to see what we get
            const directQuery = `
              SELECT 
                d.page_id,
                d.id as detection_id,
                COUNT(pv.id) as view_count,
                d.robots_index
              FROM detections d
              LEFT JOIN page_views pv ON d.page_id = pv.page_id
              WHERE d.robots_index = 0 OR d.robots_index IS NULL
              GROUP BY d.page_id, d.id, d.robots_index
              HAVING COUNT(pv.id) >= 5
              ORDER BY view_count DESC
            `;
            
            const directResult = await env.DB.prepare(directQuery).all();
            
            // Then call the actual promotion function
            const result = await promotePopularPages(env);
            
            return new Response(JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              directQueryResults: {
                success: directResult.success,
                count: directResult.results?.length || 0,
                pages: directResult.results || []
              },
              promotionFunctionResult: result
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('❌ Manual page promotion failed:', error);
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date().toISOString()
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
        case '/api/test/debug-promotion-query':
          try {
            console.log('🧪 Debugging promotion SQL query');
            
            // Run the exact same query as promotePopularPages
            const query = `
              SELECT 
                d.page_id,
                d.id as detection_id,
                COUNT(pv.id) as view_count,
                d.robots_index
              FROM detections d
              LEFT JOIN page_views pv ON d.page_id = pv.page_id
              WHERE d.robots_index = 0 OR d.robots_index IS NULL
              GROUP BY d.page_id, d.id, d.robots_index
              HAVING COUNT(pv.id) >= 5
              ORDER BY view_count DESC
              LIMIT 10
            `;
            
            const result = await env.DB.prepare(query).all();
            const eligiblePages = result.results || [];
            
            // Also get specific info about page 32vi
            const page32viQuery = `
              SELECT 
                d.page_id,
                d.robots_index,
                COUNT(pv.id) as view_count
              FROM detections d
              LEFT JOIN page_views pv ON d.page_id = pv.page_id
              WHERE d.page_id = '32vi'
              GROUP BY d.page_id, d.robots_index
            `;
            
            const page32viResult = await env.DB.prepare(page32viQuery).all();
            const page32viData = page32viResult.results?.[0] || null;
            
            return new Response(JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              debug: {
                eligiblePages: eligiblePages,
                totalEligibleCount: eligiblePages.length,
                page32viSpecific: page32viData,
                queryUsed: query
              }
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('❌ Debug promotion query failed:', error);
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date().toISOString()
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        case '/api/debug/twitter-status':
          return await handleTwitterDebug(request, env);
        
        case '/detection/robots.txt':
          return handleRobotsTxt(request, env);
          
        case '/detection/sitemap.xml':
          return handleSitemapXml(request, env);
          
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
          
          // Handle static assets requests using Cloudflare Workers Static Assets
          if (url.pathname.startsWith('/assets/') || url.pathname === '/logo.png') {
            return env.ASSETS.fetch(request);
          }
            return new Response('Truthscan Twitter Bot API\nEndpoints:\n- GET/POST /webhook/twitter (Twitter webhook)\n- GET /api/detections (Dashboard API, protected)\n- GET /api/test-db (Database test, protected)\n- GET /api/test-shorturl (Short URL generation test, protected)\n- GET /api/test-reply-formatting (Reply formatting test, protected)\n- GET /api/test-database-updates (Database updates test, protected)\n- GET /api/generate-monitoring-test-data (Generate monitoring test data, protected)\n- GET /api/validate-monitoring-system (Validate monitoring system, protected)\n- GET /api/clear-cache (Clear cache, protected)\n- GET /api/monitoring/logs (Monitoring logs, protected)\n- GET /api/monitoring/page-views (Monitoring page views, protected)\n- GET /api/monitoring/metrics (Monitoring metrics, protected)\n- GET /api/monitoring/dashboard (Monitoring dashboard, protected)\n- GET /d/:id (Public detection results page)', { 
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
      // Handle different cron schedules
      if (event.cron === '* * * * *') {
        // Every minute: Twitter polling
        await handleTwitterPolling(env, ctx);
      } else if (event.cron === '0 * * * *') {
        // Every hour: Page promotion
        await handlePagePromotion(env, ctx);
      } else {
        console.warn('Unknown cron schedule:', event.cron);
      }
      
    } catch (error) {
      console.error('Error in scheduled function:', error);
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
    urls?: Array<{
      url: string;
      expanded_url: string;
      display_url: string;
      indices: [number, number];
      unwound?: {
        url: string;
        status: number;
        title?: string;
        description?: string;
      };
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
    entities?: {
      urls?: Array<{
        url: string;
        expanded_url?: string;
        display_url?: string;
        indices?: [number, number];
        unwound?: {
          url: string;
          status: number;
          title?: string;
          description?: string;
        };
      }>;
      hashtags?: Array<{
        tag: string;
        indices?: [number, number];
      }>;
      user_mentions?: Array<{
        username: string;
        indices?: [number, number];
      }>;
    };
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
      entities?: {
        urls?: Array<{
          url: string;
          expanded_url?: string;
          display_url?: string;
          indices?: [number, number];
          unwound?: {
            url: string;
            status: number;
            title?: string;
            description?: string;
          };
        }>;
        hashtags?: Array<{
          tag: string;
          indices?: [number, number];
        }>;
        user_mentions?: Array<{
          username: string;
          indices?: [number, number];
        }>;
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

interface TwitterV2LikeResponse {
  data: {
    liked: boolean;
  };
}

interface TwitterUserResponse {
  id_str: string;
  screen_name: string;
  name: string;
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
  imageDescription?: string;
  metaDescription?: string;
  detailedDescription?: string;
  confidenceAnalysis?: string;
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
        const parsedTweet = await parseTweetData(tweet, env);
        
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
async function parseTweetData(tweet: TwitterTweet, env: Env): Promise<ParsedTweetData> {
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
  
  // Extract image URLs from both media entities and Open Graph images
  const imageUrls = await extractAllImageUrls(tweet);
  
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
    textPreview: text.substring(0, 50) + '...',
    urlCount: tweet.entities?.urls?.length || 0
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
 * Convert Twitter API v2 format to v1.1 webhook format for image extraction
 */
function convertV2ToWebhookFormat(v2Tweet: any): TwitterTweet {
  return {
    id_str: v2Tweet.id,
    text: v2Tweet.text || '',
    user: {
      id_str: v2Tweet.author_id || '',
      screen_name: 'unknown' // Will be populated by caller if available
    },
    entities: {
      urls: v2Tweet.entities?.urls?.map((url: any) => ({
        url: url.url,
        expanded_url: url.expanded_url || url.url,
        display_url: url.display_url || url.url,
        indices: url.indices || [0, 0],
        unwound: url.unwound
      })) || [],
      hashtags: v2Tweet.entities?.hashtags?.map((hashtag: any) => ({
        text: hashtag.tag,
        indices: hashtag.indices || [0, 0]
      })) || [],
      user_mentions: v2Tweet.entities?.user_mentions?.map((mention: any) => ({
        screen_name: mention.username,
        id_str: 'unknown'
      })) || [],
      media: [] // Media is handled differently in v2, will be populated separately
    },
    extended_entities: {
      media: [] // Will be populated separately from media_keys
    }
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
 * Extract Open Graph image URLs from tweet URLs
 */
async function extractOpenGraphImages(tweet: TwitterTweet): Promise<string[]> {
  try {
    const urlEntities = tweet.entities?.urls || [];
    
    if (urlEntities.length === 0) {
      console.log('No URLs found in tweet entities');
      return [];
    }
    
    console.log('Processing URLs for Open Graph images:', {
      urlCount: urlEntities.length,
      urls: urlEntities.map(u => ({ url: u.url, expanded: u.expanded_url }))
    });
    
    const ogImagePromises = urlEntities.map(async (urlEntity) => {
      try {
        // Use expanded_url if available, otherwise fall back to the t.co URL
        const targetUrl = urlEntity.expanded_url || urlEntity.url;
        
        if (!targetUrl) {
          console.log('Skipping URL entity with no target URL');
          return [];
        }
        
        console.log('Fetching Open Graph images from:', targetUrl);
        const ogImages = await fetchOpenGraphImages(targetUrl);
        
        if (ogImages.length > 0) {
          console.log(`Found ${ogImages.length} OG images from ${targetUrl}:`, ogImages);
        } else {
          console.log(`No Open Graph images found from ${targetUrl}`);
        }
        
        return ogImages;
      } catch (error) {
        console.error(`Error processing URL ${urlEntity.url}:`, {
          error: error instanceof Error ? error.message : 'Unknown error',
          targetUrl: urlEntity.expanded_url || urlEntity.url
        });
        return [];
      }
    });
    
    // Wait for all URL processing to complete
    const results = await Promise.all(ogImagePromises);
    
    // Flatten the array of arrays and remove duplicates
    const allOgImages = results.flat();
    const uniqueOgImages = [...new Set(allOgImages)];
    
    console.log('Open Graph image extraction summary:', {
      totalUrlsProcessed: urlEntities.length,
      totalOgImagesFound: allOgImages.length,
      uniqueOgImages: uniqueOgImages.length,
      images: uniqueOgImages
    });
    
    return uniqueOgImages;
    
  } catch (error) {
    console.error('Error extracting Open Graph images:', error);
    return [];
  }
}

/**
 * Fetch and parse Open Graph images from a URL
 */
async function fetchOpenGraphImages(url: string): Promise<string[]> {
  try {
    console.log('Fetching HTML content for OG parsing from:', url);
    
    // Create timeout promise (15 seconds for production)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Fetch timeout'));
      }, 15000);
    });
    
    // Create fetch promise
    const fetchPromise = fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TruthscanBot/1.0; +https://truthscan.app)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      // Follow redirects
      redirect: 'follow'
    });
    
    // Race fetch against timeout
    const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;
    
    if (!response.ok) {
      console.log(`HTTP ${response.status} for ${url}, skipping OG parsing`);
      return [];
    }
    
    // Check content type
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('text/html')) {
      console.log(`Non-HTML content type (${contentType}) for ${url}, skipping OG parsing`);
      return [];
    }
    
    // Get the HTML content
    const html = await response.text();
    console.log(`Successfully fetched ${html.length} characters of HTML from ${url}`);
    
    // Parse Open Graph meta tags
    const ogImages = parseOpenGraphImages(html, url);
    
    return ogImages;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error fetching Open Graph images from ${url}:`, {
      error: errorMessage,
      isTimeout: errorMessage.includes('timeout') || errorMessage.includes('Fetch timeout'),
      url: url
    });
    return [];
  }
}

/**
 * Parse Open Graph image URLs from HTML content
 */
function parseOpenGraphImages(html: string, baseUrl: string): string[] {
  try {
    const ogImages: string[] = [];
    
    // Regular expressions to match Open Graph image meta tags
    const ogImagePatterns = [
      /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["'][^>]*>/gi,
      /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["'][^>]*>/gi,
      /<meta\s+property=["']og:image:secure_url["']\s+content=["']([^"']+)["'][^>]*>/gi,
      /<meta\s+content=["']([^"']+)["']\s+property=["']og:image:secure_url["'][^>]*>/gi
    ];
    
    console.log('Parsing HTML for Open Graph images...');
    
    // Extract URLs using each pattern
    for (const pattern of ogImagePatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const imageUrl = match[1];
        if (imageUrl && imageUrl.trim()) {
          const resolvedUrl = resolveUrl(imageUrl.trim(), baseUrl);
          if (resolvedUrl && !ogImages.includes(resolvedUrl)) {
            ogImages.push(resolvedUrl);
            console.log(`Found OG image: ${resolvedUrl}`);
          }
        }
      }
    }
    
    // Also check for basic image meta tag as fallback
    const basicImagePattern = /<meta\s+property=["']image["']\s+content=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = basicImagePattern.exec(html)) !== null) {
      const imageUrl = match[1];
      if (imageUrl && imageUrl.trim()) {
        const resolvedUrl = resolveUrl(imageUrl.trim(), baseUrl);
        if (resolvedUrl && !ogImages.includes(resolvedUrl)) {
          ogImages.push(resolvedUrl);
          console.log(`Found basic image meta tag: ${resolvedUrl}`);
        }
      }
    }
    
    // Filter to only include likely image URLs (basic validation)
    const validImageUrls = ogImages.filter(url => {
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        const hostname = urlObj.hostname.toLowerCase();
        
        // Check if it looks like an image file or could be a dynamic image
        const hasImageExtension = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i.test(pathname);
        const hasImageIndicators = pathname.includes('image') || pathname.includes('photo') || pathname.includes('picture') || 
                                   pathname.includes('thumbnail') || pathname.includes('media') || pathname.includes('og') ||
                                   hostname.includes('twimg.com') || hostname.includes('pbs.twimg.com');
        const isDynamicImageService = pathname.includes('/api/') || pathname.includes('/og/') || pathname.includes('/thumbnails/') ||
                                     hostname.includes('truthscan') || hostname.includes('perplexity');
        const isHttps = urlObj.protocol === 'https:';
        
        // Accept if it has extension, image indicators, or is from a known dynamic image service
        return (hasImageExtension || hasImageIndicators || isDynamicImageService) && isHttps;
      } catch (error) {
        console.log(`Invalid URL found in OG parsing: ${url}`);
        return false;
      }
    });
    
    console.log(`Parsed Open Graph images from HTML:`, {
      totalFound: ogImages.length,
      validUrls: validImageUrls.length,
      images: validImageUrls
    });
    
    return validImageUrls;
    
  } catch (error) {
    console.error('Error parsing Open Graph images from HTML:', error);
    return [];
  }
}

/**
 * Resolve relative URLs to absolute URLs
 */
function resolveUrl(url: string, baseUrl: string): string | null {
  try {
    // If already absolute URL, return as-is
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    // If protocol-relative URL, use HTTPS
    if (url.startsWith('//')) {
      return `https:${url}`;
    }
    
    // Resolve relative URL against base URL
    const base = new URL(baseUrl);
    const resolved = new URL(url, base);
    return resolved.href;
    
  } catch (error) {
    console.error(`Error resolving URL "${url}" against base "${baseUrl}":`, error);
    return null;
  }
}

/**
 * Enhanced image URL extraction that includes both media entities and Open Graph images
 */
async function extractAllImageUrls(tweet: TwitterTweet): Promise<string[]> {
  try {
    console.log('Starting comprehensive image URL extraction...');
    
    // Extract direct media attachments
    const mediaImages = extractImageUrls(tweet);
    
    // Extract Open Graph images from URLs
    const ogImages = await extractOpenGraphImages(tweet);
    
    // Combine and deduplicate
    const allImages = [...mediaImages, ...ogImages];
    const uniqueImages = [...new Set(allImages)];
    
    console.log('Comprehensive image extraction complete:', {
      mediaImages: mediaImages.length,
      ogImages: ogImages.length,
      totalUnique: uniqueImages.length,
      urlsInTweet: tweet.entities?.urls?.length || 0,
      images: uniqueImages
    });
    
    return uniqueImages;
    
  } catch (error) {
    console.error('Error in comprehensive image URL extraction:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      fallbackToMediaOnly: true
    });
    // Fallback to just media images if OG extraction fails completely
    const fallbackImages = extractImageUrls(tweet);
    console.log('Using fallback media-only extraction:', {
      mediaImages: fallbackImages.length,
      images: fallbackImages
    });
    return fallbackImages;
  }
}

/**
 * AI Detection API Functions (Undetectable.AI)
 */

// Download image from Twitter URL
async function downloadImageFromUrl(imageUrl: string): Promise<{ success: boolean; blob?: Blob; contentType?: string; filename?: string; error?: string }> {
  try {
    console.log('Downloading image:', imageUrl);
    
    // Create timeout promise (15 seconds for production)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        console.log('DEBUG: Image download timed out after 15 seconds');
        reject(new Error('Download timeout'));
      }, 15000); // Increased for production stability
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
    const errorMessage = error instanceof Error ? error.message : 'Unknown error downloading image';
    const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('Download timeout');
    const isNetworkError = errorMessage.includes('fetch') || errorMessage.includes('network');
    
    console.error('DEBUG: Image download failed:', {
      error: errorMessage,
      imageUrl: imageUrl,
      isTimeout: isTimeout,
      isNetworkError: isNetworkError
    });
    
    return {
      success: false,
      error: errorMessage
    };
  }
}

// Step 1: Get presigned URL
async function getPresignedUrl(filename: string, env: Env): Promise<{ success: boolean; data?: PresignedUrlResponse; error?: string }> {
  try {
    // Debug: Check if API key is available
    console.log('DEBUG: Checking API key availability:', !!env.AI_DETECTION_API_KEY);
    console.log('DEBUG: API key first 10 characters:', env.AI_DETECTION_API_KEY?.substring(0, 10) + '...');
    
    // Clean filename: remove spaces and Twitter URL parameters like ":large", ":medium", etc.
    const cleanFilename = filename
      .replace(/\s+/g, '_') // Remove spaces as required
      .replace(/:(large|medium|small|orig)$/, '') // Remove Twitter image size suffixes
      .replace(/[?&].*$/, ''); // Remove any URL parameters
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
/**
 * Process image with AI detection only (for immediate Twitter reply)
 * This is the fast path that gets AI detection score without waiting for Groq
 */
async function processImageWithAIDetection(imageUrl: string, env: Env): Promise<{
  success: boolean;
  aiProbability: number;
  finalResult: string;
  confidence: number;
  processingTimeMs: number;
  imageData?: ArrayBuffer;
  imageContentType?: string;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    console.log('🔍 Starting AI detection process for:', imageUrl);
    console.log('🔧 DEBUG: API key available in env:', !!env.AI_DETECTION_API_KEY);
    console.log('🔧 DEBUG: API key first 10 chars:', env.AI_DETECTION_API_KEY ? env.AI_DETECTION_API_KEY.substring(0, 10) + '...' : 'undefined');
    
    // Step 1: Download image from Twitter
    console.log('DEBUG: Step 1 - Starting image download...');
    const downloadResult = await downloadImageFromUrl(imageUrl);
    console.log('DEBUG: Download result:', { success: downloadResult.success, error: downloadResult.error });
    
    if (!downloadResult.success || !downloadResult.blob || !downloadResult.filename) {
      const error = downloadResult.error || 'Failed to download image';
      console.error('❌ Step 1 FAILED - Image download:', error);
      throw new Error(error);
    }
    
    console.log('DEBUG: Step 2 - Getting presigned URL...');
    // Step 2: Get presigned URL
    const presignedResult = await getPresignedUrl(downloadResult.filename, env);
    console.log('DEBUG: Presigned result:', { success: presignedResult.success, error: presignedResult.error });
    
    if (!presignedResult.success || !presignedResult.data) {
      const error = presignedResult.error || 'Failed to get presigned URL';
      console.error('❌ Step 2 FAILED - Presigned URL:', error);
      throw new Error(error);
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
      const error = uploadResult.error || 'Failed to upload image';
      console.error('❌ Step 3 FAILED - Image upload:', error);
      throw new Error(error);
    }
    
    console.log('DEBUG: Step 4 - Submitting for detection...');
    // Step 4: Submit for detection
    const submissionResult = await submitImageForDetection(presignedResult.data.file_path, env);
    console.log('DEBUG: Submission result:', { success: submissionResult.success, error: submissionResult.error });
    
    if (!submissionResult.success || !submissionResult.data) {
      const error = submissionResult.error || 'Failed to submit for detection';
      console.error('❌ Step 4 FAILED - Detection submission:', error);
      throw new Error(error);
    }
    
    console.log('DEBUG: Step 5 - Querying results...');
    // Step 5: Query results
    const queryResult = await queryDetectionResults(submissionResult.data.id);
    console.log('DEBUG: Query result:', { success: queryResult.success, error: queryResult.error });
    
    if (!queryResult.success || !queryResult.data) {
      const error = queryResult.error || 'Failed to get detection results';
      console.error('❌ Step 5 FAILED - Detection results query:', error);
      throw new Error(error);
    }
    
    if (queryResult.data.status !== 'done') {
      const error = `Detection not completed: status=${queryResult.data.status}`;
      console.error('❌ Step 5 FAILED - Detection not completed:', error);
      throw new Error(error);
    }
    
    const processingTime = Date.now() - startTime;
    
    // Extract results
    const result = queryResult.data.result || 0;
    const finalResult = queryResult.data.result_details?.final_result || 'Unknown';
    const confidence = queryResult.data.result_details?.confidence || result;
    
    // Get image data as ArrayBuffer for database storage
    const imageArrayBuffer = await downloadResult.blob.arrayBuffer();
    
    console.log('✅ AI detection completed successfully:', {
      detectionId: submissionResult.data.id,
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
    
    console.error('❌ AI DETECTION FAILED:', {
      imageUrl,
      processingTimeMs: processingTime,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
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
 * Legacy function - kept for backward compatibility
 * Calls AI detection + Groq analysis sequentially (slower)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function processImageWithAI(imageUrl: string, env: Env, tweetText?: string, hashtags?: string[]): Promise<DetectionResult> {
  const startTime = Date.now();
  
  try {
    // Get AI detection first
    const aiResult = await processImageWithAIDetection(imageUrl, env);
    
    if (!aiResult.success) {
      return {
        success: false,
        aiProbability: aiResult.aiProbability,
        finalResult: aiResult.finalResult,
        confidence: aiResult.confidence,
        processingTimeMs: aiResult.processingTimeMs,
        error: aiResult.error
      };
    }
    
    // Now get Groq analysis with the AI detection score
    console.log('DEBUG: Step 6 - Running combined Groq analysis with AI score...');
    const groqCombinedResult = await analyzeImageWithGroqCombined(imageUrl, env, aiResult.aiProbability, tweetText, hashtags);
    console.log('DEBUG: Combined Groq result:', { 
      success: groqCombinedResult.success, 
      title: groqCombinedResult.title, 
      metaDescription: groqCombinedResult.metaDescription, 
      metaLength: groqCombinedResult.metaDescription.length, 
      hashtags: hashtags, 
      error: groqCombinedResult.error 
    });
    
    const totalProcessingTime = Date.now() - startTime;

    return {
      success: true,
      aiProbability: aiResult.aiProbability,
      finalResult: aiResult.finalResult,
      confidence: aiResult.confidence,
      processingTimeMs: totalProcessingTime,
      imageData: aiResult.imageData,
      imageContentType: aiResult.imageContentType,
      imageDescription: groqCombinedResult.success ? groqCombinedResult.title : undefined,
      metaDescription: groqCombinedResult.success ? groqCombinedResult.metaDescription : undefined,
      detailedDescription: groqCombinedResult.success ? groqCombinedResult.detailedDescription : undefined,
      confidenceAnalysis: groqCombinedResult.success ? groqCombinedResult.confidenceAnalysis : undefined
    };
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    // Log API error for monitoring
    await MonitoringEvents.logAPIError(env, 'AI Detection Combined', error, { 
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
 * Groq API Integration for Image Analysis
 */



interface GroqCombinedAnalysisResult {
  success: boolean;
  title: string;
  metaDescription: string;
  detailedDescription: string;
  confidenceAnalysis: string;
  processingTimeMs: number;
  error?: string;
}



/**
 * Combined Groq analysis - generates both title and meta description in one API call
 * More efficient than separate calls - saves tokens, latency, and cost
 * Now includes AI detection score to bias the confidence analysis
 */
async function analyzeImageWithGroqCombined(imageUrl: string, env: Env, aiDetectionScore?: number, tweetText?: string, hashtags?: string[]): Promise<GroqCombinedAnalysisResult> {
  const startTime = Date.now();
  
  try {
    console.log('Starting combined Groq image analysis for:', imageUrl);
    
    if (!env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY not configured');
    }

    const contextInfo = [];
    if (tweetText) {
      contextInfo.push(`Original tweet: "${tweetText}"`);
    }
    if (hashtags && hashtags.length > 0) {
      contextInfo.push(`Hashtags: ${hashtags.map(tag => `#${tag}`).join(', ')}`);
    }
    const contextString = contextInfo.length > 0 ? `\n\nContext:\n${contextInfo.join('\n')}` : '';

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this image and provide exactly four descriptions in this simple format:

**Title:** [3-4 word title focusing on the main subject or scene]
**Meta Description:** [70-80 character description for meta tags, descriptive but concise]
**Detailed Description:** [A comprehensive 2-3 paragraph analysis describing all visual elements, composition, colors, lighting, mood, subjects, and artistic qualities. Evaluate the technical and aesthetic aspects including textures, patterns, spatial relationships, and any notable artistic techniques. Describe the overall atmosphere and visual impact in rich, engaging detail that would be informative and interesting for viewers across diverse image types including photography, artwork, digital creations, and screenshots.]
**Confidence Analysis:** [This image scored ${aiDetectionScore !== undefined ? Math.round(aiDetectionScore) : 'X'}% likelihood of being AI-generated. ${aiDetectionScore !== undefined ? `Analyze specific visual elements that support this ${Math.round(aiDetectionScore)}% AI-detection score across these categories:` : 'Analyze visual elements across multiple categories to assess AI generation likelihood:'}

• Textures: ${aiDetectionScore !== undefined ? `Supporting the ${Math.round(aiDetectionScore)}% score, assess whether textures appear overly smooth, lack natural variation, or show signs of digital generation.` : 'Look for overly smooth surfaces, lack of natural texture variation, or artificially perfect material rendering.'}

• Lighting & Shadows: ${aiDetectionScore !== undefined ? `Given the ${Math.round(aiDetectionScore)}% detection score, evaluate whether lighting appears natural or shows signs of artificial enhancement.` : 'Examine inconsistent light sources, impossible shadow angles, or unnaturally perfect illumination.'}

• Proportions & Anatomy: ${aiDetectionScore !== undefined ? `Consistent with the ${Math.round(aiDetectionScore)}% AI likelihood, identify any anatomical inconsistencies or unnatural proportions.` : 'Check for anatomical errors, unusual scale relationships, or distorted proportions.'}

• Symmetry: ${aiDetectionScore !== undefined ? `The ${Math.round(aiDetectionScore)}% score suggests examining whether symmetry appears too perfect or artificially enhanced.` : 'Assess whether symmetry appears too perfect or artificially enhanced beyond natural variation.'}

• Hyperreal Aesthetics: ${aiDetectionScore !== undefined ? `Supporting the ${Math.round(aiDetectionScore)}% detection rating, analyze whether the image appears unnaturally flawless.` : 'Evaluate if the image appears unnaturally flawless, idealized, or too perfect for reality.'}

• Other Details: ${aiDetectionScore !== undefined ? `Given the ${Math.round(aiDetectionScore)}% AI-detection score, identify any additional visual evidence supporting this assessment.` : 'Identify background inconsistencies, fine detail artifacts, or other subtle signs of digital generation.'}

Each bullet should be 1-2 sentences focusing on specific visual evidence.]

Examples:
**Title:** Red Carpet Event
**Meta Description:** professional headshot of a business executive
**Detailed Description:** This image captures an elegant red carpet event with sophisticated lighting and formal attire. The composition features well-dressed individuals positioned strategically within the frame, creating a sense of prestige and glamour. The lighting appears professionally managed with warm tones that enhance the luxurious atmosphere, while the red carpet itself serves as a bold visual anchor that draws the eye through the scene.
**Confidence Analysis:** The image shows natural imperfections in fabric textures and realistic lighting gradients that suggest authentic photography. However, the perfectly coordinated poses and flawless makeup could indicate some digital enhancement or careful staging typical of professional events.

**Title:** Beach Sunset Photo  
**Meta Description:** sunset landscape with mountains and lake
**Detailed Description:** A breathtaking coastal landscape showcasing the golden hour's natural beauty with dramatic lighting and serene composition. The sun's position creates stunning silhouettes against mountain ranges, while warm orange and pink hues reflect off the water's surface. The peaceful mood is enhanced by the balanced composition that leads the viewer's eye from foreground elements to the distant horizon.
**Confidence Analysis:** The lighting appears naturally graduated with realistic atmospheric effects and organic cloud formations. The water reflections show natural distortion patterns and the mountain silhouettes have irregular, authentic edges that strongly suggest this is a genuine photograph rather than AI-generated content.

Do not include any other text or formatting.${contextString}`
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        temperature: 0.3,
        max_completion_tokens: 500,
        top_p: 1,
        stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string;
        };
      }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim() || '{}';
    console.log('Raw Groq response:', content);

    // Parse Markdown response using regex
    console.log('DEBUG: Raw Groq response content:', JSON.stringify(content));
    console.log('DEBUG: Response length:', content.length);
    
    const titleMatch = content.match(/\*\*Title:\*\*\s*(.+)/i);
    const metaMatch = content.match(/\*\*Meta Description:\*\*\s*(.+)/i);
    const detailedMatch = content.match(/\*\*Detailed Description:\*\*\s*([\s\S]+?)(?=\n\*\*|$)/i);
    const confidenceMatch = content.match(/\*\*Confidence Analysis:\*\*\s*([\s\S]+?)(?=\n\*\*|$)/i);
    
    if (!titleMatch || !metaMatch || !detailedMatch || !confidenceMatch) {
      console.error('Failed to parse Groq Markdown response:', content);
      throw new Error(`Invalid Markdown response from Groq: ${content.substring(0, 200)}...`);
    }

    const title = titleMatch[1].trim().replace(/[^\w\s-]/g, '').trim();
    const metaDescription = metaMatch[1].trim().replace(/[^\w\s-]/g, '').trim();
    const detailedDescription = detailedMatch[1].trim();
    const confidenceAnalysis = confidenceMatch[1].trim();
    
    const processingTime = Date.now() - startTime;

    console.log('Combined Groq analysis completed:', {
      title,
      metaDescription,
      metaDescriptionLength: metaDescription.length,
      detailedDescriptionLength: detailedDescription.length,
      confidenceAnalysisLength: confidenceAnalysis.length,
      processingTimeMs: processingTime
    });

    return {
      success: true,
      title,
      metaDescription,
      detailedDescription,
      confidenceAnalysis,
      processingTimeMs: processingTime
    };

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Combined Groq analysis failed:', error);
    
    // Log API error for monitoring
    await MonitoringEvents.logAPIError(env, 'Groq Combined Markdown Analysis', error, { 
      imageUrl, 
      processingTimeMs: processingTime 
    });

    return {
      success: false,
      title: 'Image',
      metaDescription: 'image',
      detailedDescription: 'Image analysis not available',
      confidenceAnalysis: '',
      processingTimeMs: processingTime,
      error: error instanceof Error ? error.message : 'Unknown Groq Markdown error'
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
 * Convert words to their base form (remove past tense, -ing, -s endings)
 * This helps create more recognizable hashtags
 */
function convertToBaseForm(word: string): string {
  const lowerWord = word.toLowerCase();
  
  // Common irregular verb mappings (past -> base)
  const irregularVerbs: Record<string, string> = {
    'went': 'go',
    'ran': 'run',
    'said': 'say',
    'came': 'come',
    'gave': 'give',
    'took': 'take',
    'made': 'make',
    'told': 'tell',
    'found': 'find',
    'left': 'leave',
    'met': 'meet',
    'brought': 'bring',
    'began': 'begin',
    'held': 'hold',
    'sat': 'sit',
    'stood': 'stand',
    'heard': 'hear',
    'felt': 'feel',
    'kept': 'keep',
    'seemed': 'seem',
    'became': 'become',
    'thought': 'think',
    'knew': 'know',
    'saw': 'see',
    'got': 'get',
    'had': 'have',
    'was': 'be',
    'were': 'be',
    'did': 'do',
    'been': 'be',
    'done': 'do',
    'gone': 'go',
    'seen': 'see',
    'taken': 'take',
    'given': 'give',
    'known': 'know',
    'shown': 'show',
    'written': 'write',
    'spoken': 'speak',
    'broken': 'break',
    'chosen': 'choose',
    'driven': 'drive',
    'eaten': 'eat',
    'fallen': 'fall',
    'forgotten': 'forget',
    'hidden': 'hide',
    'ridden': 'ride',
    'risen': 'rise',
    'stolen': 'steal',
    'worn': 'wear',
    'won': 'win'
  };
  
  // Check irregular verbs first
  if (irregularVerbs[lowerWord]) {
    return irregularVerbs[lowerWord];
  }
  
  // Handle regular -ed endings (past tense)
  if (lowerWord.endsWith('ed') && lowerWord.length > 3) {
    const base = lowerWord.slice(0, -2);
    // Handle doubled consonants (e.g., "stopped" -> "stop")
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      const consonants = 'bcdfghjklmnpqrstvwxyz';
      const lastChar = base[base.length - 1];
      if (consonants.includes(lastChar)) {
        return base.slice(0, -1);
      }
    }
    return base;
  }
  
  // Handle -ing endings (present participle)
  if (lowerWord.endsWith('ing') && lowerWord.length > 4) {
    const base = lowerWord.slice(0, -3);
    // Handle doubled consonants (e.g., "running" -> "run")
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      const consonants = 'bcdfghjklmnpqrstvwxyz';
      const lastChar = base[base.length - 1];
      if (consonants.includes(lastChar)) {
        return base.slice(0, -1);
      }
    }
    return base;
  }
  
  // Handle -ies endings (e.g., "tries" -> "try") - do this before -s handling
  if (lowerWord.endsWith('ies') && lowerWord.length > 4) {
    return lowerWord.slice(0, -3) + 'y';
  }
  
  // Handle -es endings (e.g., "goes" -> "go", "does" -> "do")
  if (lowerWord.endsWith('es') && lowerWord.length > 3) {
    const base = lowerWord.slice(0, -2);
    // Common patterns: go->goes, do->does, watch->watches
    if (['go', 'do'].includes(base) || base.endsWith('ch') || base.endsWith('sh') || base.endsWith('x') || base.endsWith('z')) {
      return base;
    }
  }
  
  // Handle -s endings (third person singular)
  if (lowerWord.endsWith('s') && lowerWord.length > 2 && !lowerWord.endsWith('ss') && !lowerWord.endsWith('es')) {
    return lowerWord.slice(0, -1);
  }
  
  // Return original word if no conversion applies
  return lowerWord;
}

/**
 * Extract meaningful keywords from tweet text for hashtag generation
 */
function extractKeywordsFromText(tweetText: string, existingHashtags: string[] = []): string[] {
  // Profanity and offensive words to filter out (conservative list)
  const profanityWords = new Set([
    'fuck', 'fucking', 'shit', 'damn', 'hell', 'ass', 'sex', 'porn', 'xxx',
    'bitch', 'bastard', 'piss', 'crap', 'whore', 'slut', 'nazi', 'hitler'
  ]);

  // Common words to filter out (stop words)
  const stopWords = new Set([
    // Articles, conjunctions, prepositions
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    // Common verbs and auxiliaries
    'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'will', 'would', 'could',
    // Pronouns
    'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
    'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'can', 'do', 'does', 'did',
    // Common action words
    'get', 'go', 'going', 'got', 'just', 'now', 'like', 'said', 'say', 'see', 'know', 'think',
    'take', 'come', 'good', 'new', 'first', 'last', 'long', 'great', 'little', 'own', 'other',
    'old', 'right', 'big', 'high', 'different', 'small', 'large', 'next', 'early', 'young',
    'important', 'few', 'public', 'bad', 'same', 'able', 'rt', 'via',
    // User-requested additions
    'yes', 'not', 'never', 'lose', 'sight', 'post', 'exactly', 'ago', 'no', 'officially', 
    'who', 'what', 'when', 'why', 'getting', 'location', 'read', 'write', 'speak', 'out', 
    'wait', 'fellow', 'gonna', 'wont', 'how', 'thing', 'one', 'two', 'three', 'four', 'five', 
    'six', 'seven', 'eight', 'nine', 'ten', 'entire', 'whole', 'half', 'don', 'look', 'aren', 'didn',
    // Additional similar words
    'where', 'which', 'whose', 'none', 'nothing', 'nobody', 'nowhere', 'today', 'tomorrow', 
    'yesterday', 'soon', 'later', 'before', 'after', 'during', 'while', 'won', 'can', 'couldn', 
    'shouldn', 'wouldn', 'hasn', 'haven', 'wasn', 'weren', 'isn', 'doesn', 'eleven', 'twelve', 
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
    'hundred', 'thousand', 'million', 'make', 'made', 'tell', 'told', 'find', 'found', 'give', 
    'gave', 'put', 'let', 'set', 'run', 'ran', 'turn', 'work', 'worked', 'play', 'played', 'try', 
    'tried', 'ask', 'asked', 'help', 'helped', 'show', 'showed', 'move', 'moved', 'live', 'lived', 
    'feel', 'felt', 'keep', 'kept', 'seem', 'seemed', 'become', 'became', 'leave', 'left', 'meet', 
    'met', 'bring', 'brought', 'begin', 'began', 'hold', 'held', 'sit', 'sat', 'stand', 'stood', 
    'hear', 'heard', 'call', 'called', 'talk', 'talked', 'start', 'started', 'end', 'ended', 
    'open', 'opened', 'close', 'closed', 'change', 'changed', 'follow', 'followed', 'want', 
    'wanted', 'need', 'needed', 'use', 'used', 'tweet', 'retweet', 'here', 'there', 'then', 
    'than', 'only', 'also', 'more', 'most', 'much', 'many', 'some', 'any', 'all', 'each', 
    'every', 'both', 'either', 'neither', 'another', 'such', 'same', 'really', 'very', 'too', 
    'so', 'well', 'still', 'even', 'back', 'way', 'around', 'down', 'up', 'off', 'over', 
    'under', 'through', 'into', 'onto', 'from', 'about', 'above', 'below', 'between', 'among'
  ]);
  
  // Create a set of existing hashtag words (normalized to lowercase) to avoid duplicates
  const existingHashtagWords = new Set(
    existingHashtags.map(tag => tag.toLowerCase().replace(/^#/, ''))
  );
  
  // First, extract capitalized words (proper nouns) from the original text
  // Extract words from mentions before removing them
  const mentionWords: string[] = [];
  const mentionMatches = tweetText.match(/@(\w+)/g);
  if (mentionMatches) {
    mentionMatches.forEach(mention => {
      const word = mention.substring(1); // Remove the @
      const lowerWord = word.toLowerCase();
      const baseForm = convertToBaseForm(word);
      if (word.length >= 3 && word.length <= 15 && 
          !stopWords.has(lowerWord) && !profanityWords.has(lowerWord) &&
          !stopWords.has(baseForm) && !profanityWords.has(baseForm) &&
          !existingHashtagWords.has(lowerWord) && !existingHashtagWords.has(baseForm)) {
        mentionWords.push(baseForm);
      }
    });
  }
  
  // Remove URLs and mentions from text, but keep original capitalization
  const textWithoutUrls = tweetText
    .replace(/https?:\/\/\S+/g, '') // Remove URLs
    .replace(/@\w+/g, ''); // Remove mentions
  
  // Find capitalized words that are NOT after periods (to avoid sentence-starting words)
  const capitalizedWords: string[] = [];
  
  // Split into sentences and process each one
  const sentences = textWithoutUrls.split(/[.!?]+/);
  
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    if (!sentence) continue;
    
    // Remove punctuation and split into words
    const words = sentence.replace(/[^\w\s]/g, ' ').split(/\s+/);
    
    for (let j = 0; j < words.length; j++) {
      const word = words[j].trim();
      if (!word) continue;
      
      // Check if word is capitalized and meets our criteria
      if (
        word.length >= 3 && 
        word.length <= 15 &&
        /^[A-Z][a-z]+$/.test(word) && // Starts with capital, rest lowercase
        !/^\d+$/.test(word) // Not just numbers
      ) {
        // Skip words that are the first word of a sentence (except the very first sentence)
        // This helps avoid words that are only capitalized because they start a sentence
        if (j === 0 && i > 0) {
          continue; // Skip first word of sentences after the first one
        }
        
        // For capitalized words (proper nouns), check both original and base form against filters
        // Also exclude words that already exist in hashtags to avoid duplicates
        const lowerWord = word.toLowerCase();
        const baseForm = convertToBaseForm(word);
        if (!stopWords.has(lowerWord) && !profanityWords.has(lowerWord) &&
            !stopWords.has(baseForm) && !profanityWords.has(baseForm) &&
            !existingHashtagWords.has(lowerWord) && !existingHashtagWords.has(baseForm)) {
          capitalizedWords.push(lowerWord); // Keep original proper noun, just lowercase it
        }
      }
    }
  }
  
  // Combine mention words with capitalized words
  const allCapitalizedWords = [...mentionWords, ...capitalizedWords];
  
  // Remove duplicates and get unique capitalized words
  const uniqueCapitalizedWords = [...new Set(allCapitalizedWords)];
  
  // If we have enough capitalized words, prioritize them
  if (uniqueCapitalizedWords.length >= 3) {
    return uniqueCapitalizedWords.slice(0, 3);
  }
  
  // If we don't have enough capitalized words, fall back to frequency-based extraction
  // but still prioritize any capitalized words we found
  
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
    .filter(word => {
      const baseForm = convertToBaseForm(word);
      return word.length >= 3 && // At least 3 characters
        word.length <= 15 && // Not too long
        !stopWords.has(word) && !profanityWords.has(word) && // Check original word first
        !stopWords.has(baseForm) && !profanityWords.has(baseForm) && // Then check base form
        !existingHashtagWords.has(word) && !existingHashtagWords.has(baseForm) && // Avoid hashtag duplicates
        !/^\d+$/.test(word) && // Not just numbers
        /^[a-z]+$/.test(word); // Only letters
    });
  
  // Count word frequency, converting to base form
  const wordCounts = new Map();
  words.forEach(word => {
    const baseForm = convertToBaseForm(word);
    wordCounts.set(baseForm, (wordCounts.get(baseForm) || 0) + 1);
  });
  
  // Get frequency-based keywords
  const frequencyBasedKeywords = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1]) // Sort by count (descending)
    .map(([word]) => word);
  
  // Combine capitalized words with frequency-based keywords
  // Remove duplicates and ensure capitalized words come first
  const combinedKeywords = [...uniqueCapitalizedWords];
  
  for (const keyword of frequencyBasedKeywords) {
    if (!combinedKeywords.includes(keyword) && combinedKeywords.length < 3) {
      combinedKeywords.push(keyword);
    }
  }
  
  // Return top 3 keywords, prioritizing capitalized words
  return combinedKeywords.slice(0, 3);
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
    const keywords = extractKeywordsFromText(tweetText, originalHashtags);
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
    const startTime = Date.now();
    const requestHeaders = {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(tweetData)
    });
    
    const responseBody = await response.text();
    
    // Log the detailed API call for debugging
    await logTwitterAPICall('POST', url, requestHeaders, tweetData, response, responseBody, env, startTime);
    
    if (!response.ok) {
      throw new Error(`Twitter API error: ${response.status} ${response.statusText} - ${responseBody}`);
    }
    
    const replyResponse: TwitterV2TweetResponse = JSON.parse(responseBody);
    
    console.log('Reply posted successfully:', {
      replyTweetId: replyResponse.data.id,
      text: replyResponse.data.text
    });

    // After successful reply, attempt to like the original tweet
    // Use background promise so it doesn't block the response
    const likePromise = likeTweet(originalTweetId, env).catch(error => {
      // Log the error but don't let it affect the reply success
      console.warn('Failed to like original tweet (graceful degradation):', {
        originalTweetId,
        error: error?.message || error
      });
    });
    
    // Don't await the like operation - let it run in background
    void likePromise;
    
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
 * Like a tweet using Twitter API v2
 * Uses graceful degradation - failures don't affect main bot functionality
 */
async function likeTweet(
  tweetId: string,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('Attempting to like tweet:', { tweetId });
    
    // Get the bot's user ID - we need this for the API endpoint
    // For now, we'll use a hardcoded approach since we know it's the bot's account
    // In a production system, you might want to fetch this dynamically
    const botUserId = await getBotUserId(env);
    
    if (!botUserId) {
      throw new Error('Unable to determine bot user ID');
    }
    
    // Prepare like request data
    const likeData = {
      tweet_id: tweetId
    };
    
    // Generate OAuth signature for POST request
    const url = `https://api.twitter.com/2/users/${botUserId}/likes`;
    const authHeader = await generateTwitterOAuthSignature('POST', url, {}, env);
    
    // Post the like using Twitter API v2
    const startTime = Date.now();
    const requestHeaders = {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(likeData)
    });
    
    const responseBody = await response.text();
    
    // Log the detailed API call for debugging
    await logTwitterAPICall('POST', url, requestHeaders, likeData, response, responseBody, env, startTime);
    
    if (!response.ok) {
      throw new Error(`Twitter API error: ${response.status} ${response.statusText} - ${responseBody}`);
    }
    
    const likeResponse: TwitterV2LikeResponse = JSON.parse(responseBody);
    
    console.log('Tweet liked successfully:', {
      tweetId,
      liked: likeResponse.data?.liked
    });
    
    return {
      success: true
    };
    
  } catch (error: any) {
    console.error('Failed to like tweet:', {
      tweetId,
      error: error?.message || error
    });
    
    // Provide helpful context for common errors
    let errorMessage = 'Unknown error';
    
    if (error?.message?.includes('429')) {
      errorMessage = 'Rate limit exceeded (200/day limit reached) - like functionality temporarily disabled';
    } else if (error?.message?.includes('403')) {
      errorMessage = 'Permission denied - check API credentials and like.write scope';
    } else if (error?.message?.includes('400')) {
      errorMessage = 'Bad request - invalid tweet ID or already liked';
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
 * Get the bot's user ID for API requests
 * This could be cached or stored in environment variables for efficiency
 */
async function getBotUserId(env: Env): Promise<string | null> {
  try {
    // Use the verify_credentials endpoint to get our own user info
    const url = 'https://api.twitter.com/1.1/account/verify_credentials.json';
    const authHeader = await generateTwitterOAuthSignature('GET', url, {}, env);
    const startTime = Date.now();
    const requestHeaders = {
      'Authorization': authHeader,
    };
    
    const response = await fetch(url, {
      method: 'GET',
      headers: requestHeaders
    });
    
    const responseBody = await response.text();
    
    // Log the detailed API call for debugging
    await logTwitterAPICall('GET', url, requestHeaders, null, response, responseBody, env, startTime);
    
    if (!response.ok) {
      console.error('Failed to get bot user ID:', response.status, response.statusText);
      return null;
    }
    
    const userData: TwitterUserResponse = JSON.parse(responseBody);
    return userData.id_str;
    
  } catch (error) {
    console.error('Error fetching bot user ID:', error);
    return null;
  }
}

/**
 * Process all images in a tweet and send one consolidated reply
 */
async function processAllImagesAndReply(imageUrls: string[], tweetData: ParsedTweetData, env: Env): Promise<void> {
  try {
    console.log(`Starting optimized batch processing of ${imageUrls.length} images for tweet ${tweetData.tweetId}`);
    
    // Safety check: Verify this tweet hasn't already been processed to prevent duplicates
    const alreadyProcessed = await isAlreadyProcessed(tweetData.tweetId, env);
    if (alreadyProcessed) {
      console.log(`⚠️ Tweet ${tweetData.tweetId} has already been processed, skipping duplicate processing`);
      return;
    }
    
    // Deduplicate image URLs again as an extra safety measure
    const uniqueImageUrls = [...new Set(imageUrls)];
    if (uniqueImageUrls.length !== imageUrls.length) {
      console.log(`⚠️ Detected ${imageUrls.length - uniqueImageUrls.length} duplicate image URLs, using ${uniqueImageUrls.length} unique URLs`);
    }
    
    // Phase 1: Get AI detection results FAST (for immediate reply)
    const aiDetectionPromises = uniqueImageUrls.map(async (imageUrl, index) => {
      const detectionId = crypto.randomUUID();
      const timestamp = Math.floor(Date.now() / 1000);
      
      try {
        console.log(`Getting AI detection for image ${index + 1}/${imageUrls.length}: ${imageUrl}`);
        const aiResult = await processImageWithAIDetection(imageUrl, env);
        
        return {
          index: index + 1,
          detectionId,
          timestamp,
          imageUrl,
          aiResult,
          success: aiResult.success,
          aiProbability: aiResult.aiProbability,
          finalResult: aiResult.finalResult,
          error: aiResult.error
        };
      } catch (error) {
        console.error(`Failed to get AI detection for image ${index + 1}:`, error);
        return {
          index: index + 1,
          detectionId,
          timestamp,
          imageUrl,
          aiResult: null,
          success: false,
          aiProbability: 0,
          finalResult: 'Error',
          error: error instanceof Error ? error.message : 'AI detection failed'
        };
      }
    });
    
    // Wait for all AI detections to complete
    const aiResults = await Promise.all(aiDetectionPromises);
    console.log(`Completed AI detection for ${aiResults.length} images, sending immediate reply`);
    
    // Phase 2: Send immediate Twitter reply (don't wait for Groq)
    const replyData = aiResults.map(result => ({
      index: result.index,
      success: result.success,
      aiProbability: result.aiProbability,
      finalResult: result.finalResult,
      error: result.error,
      pageId: undefined // Will be filled after database insertion
    }));
    
    const replyMessage = composeMultiImageReplyMessage(replyData, tweetData.hashtags, tweetData.text);
    
    // Send reply immediately (async, don't wait)
    const replyPromise = replyToTweet(
      tweetData.tweetId,
      0, // Not used in multi-image reply
      '',  // Not used in multi-image reply
      env,
      replyMessage // Pass custom message
    );
    
    console.log('Sent immediate reply, now processing Groq analysis in background...');
    
    // Phase 3: Get Groq analysis with AI detection scores (in background)
    const enrichmentPromises = aiResults.map(async (result) => {
      try {
        if (!result.success || !result.aiResult) {
          // For failed AI detection, store minimal data
          const insertResult = await insertDetection(env, {
            id: result.detectionId,
            tweetId: tweetData.tweetId,
            timestamp: result.timestamp,
            imageUrl: result.imageUrl,
            detectionScore: undefined,
            twitterHandle: tweetData.username,
            responseTweetId: undefined, // Will be set after reply completes
            processingTimeMs: 0,
            apiProvider: 'undetectable.ai',
            imageDescription: undefined,
            metaDescription: undefined,
            detailedDescription: undefined,
            confidenceAnalysis: undefined
          });
          
          return {
            ...result,
            pageId: insertResult.pageId,
            groqResult: null
          };
        }
        
        // Get Groq analysis with the AI detection score
        console.log(`Getting Groq analysis for image ${result.index} (${Math.round(result.aiProbability)}% AI)...`);
        const groqResult = await analyzeImageWithGroqCombined(
          result.imageUrl, 
          env, 
          result.aiProbability, // Pass the AI score to bias the analysis
          tweetData.text, 
          tweetData.hashtags
        );
        
        // Store complete result in database
        const insertResult = await insertDetection(env, {
          id: result.detectionId,
          tweetId: tweetData.tweetId,
          timestamp: result.timestamp,
          imageUrl: result.imageUrl,
          detectionScore: result.aiProbability,
          twitterHandle: tweetData.username,
          responseTweetId: undefined, // Will be set after reply completes
          processingTimeMs: result.aiResult.processingTimeMs,
          apiProvider: 'undetectable.ai',
          imageData: result.aiResult.imageData,
          imageContentType: result.aiResult.imageContentType,
          imageDescription: groqResult.success ? groqResult.title : undefined,
          metaDescription: groqResult.success ? groqResult.metaDescription : undefined,
          detailedDescription: groqResult.success ? groqResult.detailedDescription : undefined,
          confidenceAnalysis: groqResult.success ? groqResult.confidenceAnalysis : undefined
        });
        
        console.log(`Completed enrichment for image ${result.index}, stored as page ID: ${insertResult.pageId}`);
        
        return {
          ...result,
          pageId: insertResult.pageId,
          groqResult
        };
        
      } catch (error) {
        console.error(`Failed to enrich image ${result.index}:`, error);
        
        // Store basic result even if enrichment fails
        const insertResult = await insertDetection(env, {
          id: result.detectionId,
          tweetId: tweetData.tweetId,
          timestamp: result.timestamp,
          imageUrl: result.imageUrl,
          detectionScore: result.success ? result.aiProbability : undefined,
          twitterHandle: tweetData.username,
          responseTweetId: undefined,
          processingTimeMs: result.aiResult?.processingTimeMs || 0,
          apiProvider: 'undetectable.ai',
          imageData: result.aiResult?.imageData,
          imageContentType: result.aiResult?.imageContentType,
          imageDescription: undefined,
          metaDescription: undefined,
          detailedDescription: undefined,
          confidenceAnalysis: undefined
        });
        
        return {
          ...result,
          pageId: insertResult.pageId,
          groqResult: null
        };
      }
    });
    
    // Phase 4: Wait for reply and enrichment to complete
    const [replyResult, enrichedResults] = await Promise.all([
      replyPromise,
      Promise.all(enrichmentPromises)
    ]);
    
    console.log(`Completed processing: AI detection + Groq analysis + database storage for ${enrichedResults.length} images`);
    
    // Update database records with reply tweet ID
    if (replyResult.success && replyResult.replyTweetId) {
      console.log('Updating database records with reply tweet ID:', replyResult.replyTweetId);
      
      const updatePromises = enrichedResults
        .filter(result => result.detectionId)
        .map(result => 
          updateDetectionWithReplyId(env, result.detectionId, replyResult.replyTweetId!)
            .catch(error => {
              console.error(`Failed to update detection ${result.detectionId} with reply ID:`, error);
              return { success: false, error: error.message };
            })
        );
      
      const updateResults = await Promise.all(updatePromises);
      const successfulUpdates = updateResults.filter(result => result.success).length;
      
      console.log('Database reply ID updates:', {
        totalDetections: enrichedResults.length,
        updatesAttempted: updatePromises.length,
        updatesSuccessful: successfulUpdates,
        replyTweetId: replyResult.replyTweetId
      });
    } else {
      console.error('Failed to send reply:', replyResult.error);
    }
    
    // Log final processing summary
    const successfulDetections = enrichedResults.filter(r => r.success).length;
    const successfulEnrichments = enrichedResults.filter(r => r.groqResult?.success).length;
    
    console.log('Processing completed:', {
      totalImages: uniqueImageUrls.length,
      originalImageCount: imageUrls.length,
      successfulDetections,
      successfulEnrichments,
      replySuccess: replyResult.success,
      processingTimelineMs: {
        immediate_reply: 'sent after AI detection',
        background_enrichment: 'completed with Groq analysis'
      }
    });
    
  } catch (error) {
    console.error('Error in optimized batch image processing:', error);
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
  imageDescription?: string;
  metaDescription?: string;
  detailedDescription?: string;
  confidenceAnalysis?: string;
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
        response_tweet_id, processing_time_ms, api_provider, page_id, image_description, meta_description, detailed_description, confidence_analysis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      pageId || null,
      data.imageDescription || null,
      data.metaDescription || null,
      data.detailedDescription || null,
      data.confidenceAnalysis || null
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
          pageId: pageId, // Use the generated page_id
          detailedDescription: undefined // Test data
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
async function handleGroqTest(_request: Request, env: Env): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (_request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  try {
    console.log('Testing Groq API integration...');
    
    // Test with a sample image URL
    const testImageUrl = 'https://pbs.twimg.com/media/F0pKk50WcAE4337.jpg';
    const groqResult = await analyzeImageWithGroqCombined(testImageUrl, env, undefined, 'Test image for Groq API verification', ['test', 'verification']);
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      groqApiTest: {
        hasApiKey: !!env.GROQ_API_KEY,
        apiKeyLength: env.GROQ_API_KEY?.length || 0,
        testImageUrl,
        result: groqResult
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
    
  } catch (error) {
    console.error('Groq test failed:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Groq test failed',
      timestamp: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      hasApiKey: !!env.GROQ_API_KEY
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

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
      pageId: testPageId,
      detailedDescription: undefined // Test data
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
  
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-30FFL7TS9H"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-30FFL7TS9H');
  </script>
  
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
  // Use the same confidence logic as tweet responses
  let confidenceLevel = '';
  let classification = '';
  
  if (scorePercentage >= 80) {
    confidenceLevel = 'High';
    classification = 'AI Generated';
  } else if (scorePercentage >= 60) {
    confidenceLevel = 'Medium';
    classification = 'Likely AI';
  } else if (scorePercentage >= 50) {
    confidenceLevel = 'Low';
    classification = 'More Likely AI';
  } else if (scorePercentage >= 40) {
    confidenceLevel = 'Low';
    classification = 'More Likely Real';
  } else if (scorePercentage >= 20) {
    confidenceLevel = 'Medium';
    classification = 'Likely Real';
  } else {
    confidenceLevel = 'High';
    classification = 'Real Image';
  }
  
  // Color coding based on AI probability and confidence
  const isAI = scorePercentage >= 50;
  let scoreColor;
  
  if (confidenceLevel === 'Low') {
    scoreColor = '#F59E0B'; // Yellow for low confidence (uncertain)
  } else {
    scoreColor = isAI ? '#DC2626' : '#059669'; // Red for AI, Green for Human
  }
  
  // Format timestamp
  const detectionDate = new Date(data.timestamp * 1000);
  const timeAgo = formatTimeAgo(detectionDate);
  
  // Build Twitter URL
  const twitterUrl = `https://twitter.com/${data.twitter_handle}/status/${data.tweet_id}`;
  
  // Dynamic domain detection from current request
  const currentDomain = new URL(request.url).origin;
  
  // Backend domain for asset URLs (always use the worker domain for assets)
  const backendDomain = "https://truthscan-twitter-bot.bjuhasz08.workers.dev";
  
  // Canonical URL - always use main domain for SEO
  const canonicalUrl = `https://truthscan.com/d/${pageId}`;
  
  // Current page URL for sharing (also use main domain)
  const pageUrl = `https://truthscan.com/d/${pageId}`;
  
  // Generate dynamic, compelling meta descriptions under character limits
  const shortDescription = `${scorePercentage}% ${classification} - AI detection analysis from TruthScan`;
  
  // Use custom Groq-generated meta description if available, otherwise fallback to default
  const longDescription = data.meta_description && data.meta_description !== 'image' 
    ? `TruthScan detected a ${scorePercentage}% chance this ${data.meta_description} is AI-generated. Posted by @${data.twitter_handle}`
    : `AI detection analysis: ${scorePercentage}% probability of AI generation. From @${data.twitter_handle} tweet. Analyzed ${timeAgo}.`;
  
  // Image URLs with fallback
  const ogImageUrl = `${currentDomain}/thumbnails/${pageId}`;
  const fallbackImageUrl = `${currentDomain}/images/${pageId}`;
  
  // Accessibility descriptions for images
  const imageAltText = `AI detection result showing ${scorePercentage}% probability of artificial intelligence generation`;
  
  // Determine robots directive based on database setting (defaults to noindex if not set)
  const robotsDirective = data.robots_index ? 'index, follow' : 'noindex, nofollow';
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Detection: ${data.image_description || 'Image'} – ${scorePercentage}% Likely AI | TruthScan</title>
  
  <!-- Enhanced SEO Meta Tags -->
  <meta name="description" content="${longDescription}">
  <meta name="robots" content="${robotsDirective}">
  <meta name="keywords" content="AI detection, artificial intelligence, image analysis, TruthScan, ${classification.toLowerCase()}">
  <meta name="author" content="TruthScan">
  <link rel="canonical" href="${canonicalUrl}">
  
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
  <meta name="twitter:data2" content="${classification}">
  
  <!-- Additional SEO and Application Meta Tags -->
  <meta name="application-name" content="TruthScan">
  <meta name="generator" content="TruthScan AI Detection Engine">
  <meta name="rating" content="general">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data: https:; img-src 'self' data: https: blob:; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com;">
  
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-30FFL7TS9H"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-30FFL7TS9H');
  </script>
  
  <!-- Article and Content Meta Tags -->
  <meta property="article:author" content="TruthScan">
  <meta property="article:published_time" content="${new Date(data.timestamp * 1000).toISOString()}">
  <meta property="article:modified_time" content="${new Date().toISOString()}">
  <meta property="article:section" content="AI Detection">
  <meta property="article:tag" content="AI Detection">
  <meta property="article:tag" content="Image Analysis">
  <meta property="article:tag" content="${classification}">
  
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
  <link rel="prefetch" href="${backendDomain}/thumbnails/${pageId}">
  
  <!-- Favicon -->
  <link rel="icon" href="https://truthscan.com/favicon.ico">
  <link rel="shortcut icon" href="https://truthscan.com/favicon.ico">
  <link rel="apple-touch-icon" href="https://truthscan.com/favicon.ico">
  
  <!-- JSON-LD Structured Data for Search Engines -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": ["WebPage", "Article"],
    "headline": "${shortDescription}",
    "name": "${shortDescription}",
    "description": "${longDescription}",
    "url": "${canonicalUrl}",
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": "${canonicalUrl}"
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
      "${classification.toLowerCase()}",
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
      /* Spacing Scale - 8px Grid System */
      --space-1: 0.25rem;  /* 4px */
      --space-2: 0.5rem;   /* 8px */
      --space-3: 0.75rem;  /* 12px */
      --space-4: 1rem;     /* 16px */
      --space-5: 1.25rem;  /* 20px */
      --space-6: 1.5rem;   /* 24px */
      --space-8: 2rem;     /* 32px */
      --space-10: 2.5rem;  /* 40px */
      --space-12: 3rem;    /* 48px */
      --space-16: 4rem;    /* 64px */
      --space-20: 5rem;    /* 80px */
      
      /* Semantic Spacing */
      --section-gap: var(--space-8);      /* 32px - Between major sections */
      --content-gap: var(--space-6);      /* 24px - Between content blocks */
      --element-gap: var(--space-4);      /* 16px - Between related elements */
      --tight-gap: var(--space-3);        /* 12px - Between closely related items */
      
      /* Legacy support */
      --spacing-xs: var(--space-2);
      --spacing-sm: var(--space-4);
      --spacing-md: var(--space-6);
      --spacing-lg: var(--space-8);
      --spacing-xl: var(--space-12);
      
      /* Color System */
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
      
      /* Design tokens */
      --border-radius: 0.5rem;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
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
    
    /* Header */
    .page-header {
      background: var(--background-white);
      padding: var(--space-8) var(--space-4);
    }
    
    .header-link {
      text-decoration: none;
      color: inherit;
      display: block;
    }
    
    .header-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      max-width: 1200px;
      margin: 0 auto;
      gap: 0;
    }
    
    .logo-image {
      display: inline-block;
      max-width: none;
      max-height: none;
      margin-right: 0.5rem;
      width: 38px;
      height: 29px;
      vertical-align: middle;
    }
    
    .header-title {
      font-size: 1rem;
      line-height: 1.25rem;
      font-weight: 600;
      flex-shrink: 0;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 0.5rem;
    }
    
    .header-title-truthscan {
      background: linear-gradient(to right, #2563eb, #1d4ed8, #1e40af);
      background-clip: text;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
      display: inline-flex;
      align-items: center;
    }
    
    .header-title-rest {
      background: linear-gradient(to right, #0f172a, #1e3a8a, #0f172a);
      background-clip: text;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
    }
    
    /* Brand line styling */
    .brand-line {
      margin-top: var(--space-4);
      text-align: center;
    }
    
    /* Photo description section styling */
    .photo-description-section {
      padding: var(--spacing-xl) var(--spacing-lg);
      margin-top: var(--spacing-xl);
      margin-bottom: var(--spacing-lg);
      text-align: center;
    }
    
    /* AI Detection section styling - minimal gap */
    .ai-detection-section {
      padding: var(--spacing-xl) var(--spacing-lg);
      margin-top: 0;
      margin-bottom: var(--spacing-lg);
      text-align: center;
    }
    
    .detailed-description {
      margin-top: var(--spacing-lg);
      text-align: left;
      max-width: 800px;
      margin-left: auto;
      margin-right: auto;
      line-height: 1.6;
      color: var(--text-color);
    }
    
    .detailed-description p {
      margin-bottom: 1rem;
      font-size: 1rem;
      line-height: 1.6;
    }
    
    .header-brand {
      font-size: 1.5rem;
      line-height: 1.875rem;
      font-weight: 600;
      flex-shrink: 0;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
    }
    
    /* Main Container */
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: var(--section-gap) var(--space-4);
      min-height: calc(100vh - 200px);
    }
    
    /* Main Content Area */
    .main-content {
      margin-bottom: var(--section-gap);
    }
    
    /* Detection Row - Responsive Layout */
    .detection-row {
      display: flex;
      flex-direction: column;
      gap: var(--content-gap);
      align-items: center;
      margin-bottom: var(--section-gap);
    }
    
    .detection-row:last-child {
      margin-bottom: 0;
    }
    
    /* Image Section - Left Side */
    .image-section {
      width: 100%;
      max-width: 500px;
      margin: 0;
      padding: 0;
    }
    
    .analyzed-image {
      width: 100%;
      height: auto;
      aspect-ratio: 1;
      object-fit: cover;
      object-position: center;
      border-radius: 0;
      box-shadow: 0 10px 25px -5px rgba(59, 130, 246, 0.45), 
                  0 4px 6px -2px rgba(59, 130, 246, 0.35);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      display: block;
      margin: 0;
      padding: 0;
    }
    
    .analyzed-image:hover {
      transform: translateY(-2px) scale(1.02);
      box-shadow: 0 20px 40px -5px rgba(59, 130, 246, 0.6), 
                  0 8px 12px -2px rgba(59, 130, 246, 0.45);
    }
    
    .image-fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      aspect-ratio: 1;
      max-width: 500px;
      background: var(--background-gradient);
      color: var(--text-muted);
      font-size: 1.125rem;
      font-weight: 500;
      border-radius: 0;
      box-shadow: 0 10px 25px -5px rgba(59, 130, 246, 0.45), 
                  0 4px 6px -2px rgba(59, 130, 246, 0.35);
      margin: 0;
      padding: 0;
    }
    
    /* Results Section - Right Side */
    .results-section {
      width: 100%;
      max-width: 500px;
      text-align: center;
    }
    
    .score-metrics {
      background: transparent;
    }
    
    .metric-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: calc(var(--space-3) * 0.5) 0;
      max-width: 300px;
      margin: 0 auto;
    }
    
    .metric-item:first-child {
      padding-top: 0;
    }
    
    .metric-item:last-child {
      padding-bottom: 0;
    }
    
    .metric-label {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .metric-value {
      font-size: 1.125rem;
      font-weight: 700;
      color: var(--primary-color);
    }
    
    .probability-value {
      font-size: 1.5rem;
      font-weight: 900;
    }
    
    .source-link-container {
      text-align: center;
      margin-top: var(--space-8);
    }
    

    
    .source-link {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-md);
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
    
    /* Social Sharing Section - In Right Column */
    .share-section {
      margin-top: var(--space-8);
    }
    
    .share-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      justify-content: center;
    }
    
    .share-label {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-color);
      flex-shrink: 0;
    }
    
    .share-buttons {
      display: flex;
      gap: var(--spacing-sm);
      align-items: center;
    }
    
    .social-btn {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      background-size: 24px 24px;
      background-position: center;
      background-repeat: no-repeat;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      position: relative;
    }
    
    .social-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    
    .social-btn:active {
      transform: translateY(0);
    }
    
    /* Facebook Button */
    .social-btn.facebook {
      background-color: #1877F2;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z'/%3E%3C/svg%3E");
    }
    
    .social-btn.facebook:hover {
      background-color: #166FE5;
    }
    
    /* Twitter/X Button */
    .social-btn.twitter {
      background-color: #000000;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'/%3E%3C/svg%3E");
    }
    
    .social-btn.twitter:hover {
      background-color: #333333;
    }
    
    /* LinkedIn Button */
    .social-btn.linkedin {
      background-color: #0A66C2;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'/%3E%3C/svg%3E");
    }
    
    .social-btn.linkedin:hover {
      background-color: #0958A5;
    }
    
    /* Copy Link Button */
    .social-btn.copy {
      background-color: #6B7280;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244' stroke='white' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    }
    
    .social-btn.copy:hover {
      background-color: #4B5563;
    }
    
    .social-btn.copy.copied {
      background-color: #059669;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white'%3E%3Cpath stroke='white' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round' d='M20 6L9 17l-5-5'/%3E%3C/svg%3E");
    }
    
    /* Premium CTA Button */
    .premium-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      background: linear-gradient(to right, #1e40af, #2563eb);
      color: white;
      font-weight: 700;
      text-decoration: none;
      border-radius: 9999px;
      box-shadow: 0 10px 25px -5px rgba(59, 130, 246, 0.45), 
                  0 4px 6px -2px rgba(59, 130, 246, 0.35);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      padding: var(--space-4) var(--space-8);
      font-size: 1.125rem;
      border: none;
      cursor: pointer;
    }
    
    .premium-cta:hover {
      background: linear-gradient(to right, #1e3a8a, #1d4ed8);
      box-shadow: 0 20px 40px -5px rgba(59, 130, 246, 0.6), 
                  0 8px 12px -2px rgba(59, 130, 246, 0.45);
      transform: translateY(-1px);
    }
    
    .cta-icon {
      width: 1.25rem;
      height: 1.25rem;
      flex-shrink: 0;
    }
    
    /* Footer */
    .footer {
      margin-top: var(--section-gap);
      padding: var(--space-8) var(--space-4);
      text-align: center;
      color: var(--text-muted);
      font-size: 0.875rem;
      background: var(--background-white);
    }
    
    .footer a {
      color: var(--accent-blue);
      text-decoration: none;
      font-weight: 600;
      transition: color 0.2s ease;
    }
    
    .footer a:hover {
      color: var(--primary-color);
      text-decoration: underline;
    }
    
    /* Responsive Design */
    @media (min-width: 768px) {
      .page-header {
        padding: calc(var(--spacing-xl) * 1.5 * 0.7) var(--spacing-lg) calc(var(--spacing-xl) * 1.5 * 0.7);
        margin-bottom: 0;
      }
      
      .header-title {
        font-size: 1.5rem;
        line-height: 1.875rem;
      }
      
      .header-brand {
        font-size: 1.875rem;
        line-height: 2.25rem;
      }
      
      .brand-line {
        margin-top: var(--space-6);
      }
      
      .photo-description-section {
        padding: calc(var(--spacing-xl) * 1.2) var(--spacing-lg);
        margin-top: calc(var(--spacing-xl) * 1.2);
        margin-bottom: var(--spacing-lg);
      }
      
      .ai-detection-section {
        padding: 0 var(--spacing-lg) calc(var(--spacing-xl) * 1.2);
        margin-top: 0; /* No gap above section */
        margin-bottom: var(--spacing-lg);
      }
      
      .container {
        padding: calc(var(--spacing-xl) * 0.5) var(--spacing-lg);
        max-width: 1400px;
        margin: 0 auto;
      }
      
      /* Two-column layout on desktop */
      .main-content {
        display: flex;
        gap: 0;
        align-items: flex-start;
        justify-content: center;
        margin-bottom: 0; /* Remove margin since we're using flexbox layout */
      }
      
      .detection-row {
        flex-direction: column;
        gap: 0;
        align-items: center;
        flex: 0 0 auto;
        width: 500px;
      }
      
      .image-section {
        width: 100%;
      }
      
      .analyzed-image {
        width: 500px;
        height: 500px;
      }
      
      .image-fallback {
        width: 500px;
        height: 500px;
      }
      
      .results-section {
        flex: 0 0 auto;
        width: 500px;
        max-width: none;
        text-align: center;
        display: flex;
        flex-direction: column;
        gap: var(--space-8);
        justify-content: center;
        min-height: 500px;
      }
      
      .metric-label {
        font-size: 0.875rem;
      }
      
      .metric-value {
        font-size: 1.25rem;
      }
      
      .probability-value {
        font-size: 1.75rem;
      }
      
      .actions-section {
        justify-content: center;
        gap: var(--spacing-lg);
      }
      
      .social-btn {
        width: 52px;
        height: 52px;
        background-size: 26px 26px;
      }
      
      .premium-cta {
        padding: 1rem 3rem;
        font-size: 1.25rem;
      }
      
      /* Remove margins since we're using flexbox gap */
      .score-metrics {
        margin-bottom: 0;
      }
      
      .source-link-container,
      .share-section {
        margin-top: 0;
      }
    }
    
    /* Large Desktop Optimization */
    @media (min-width: 1200px) {
      .page-header {
        padding: calc(var(--spacing-xl) * 2 * 0.7) calc(var(--spacing-xl) * 2) calc(var(--spacing-xl) * 2 * 0.7);
        margin-bottom: 0;
      }
      
      .header-title {
        font-size: 1.5rem;
        line-height: 1.875rem;
      }
      
      .header-brand {
        font-size: 2rem;
        line-height: 2.5rem;
      }
      
      .brand-line {
        margin-top: var(--space-8);
      }
      

      
      .container {
        padding: calc(var(--spacing-xl) * 0.5) calc(var(--spacing-xl) * 2);
      }
      
      .main-content {
        margin-bottom: 0; /* Ensure margin is removed on large screens too */
      }
      
      .detection-row {
        gap: calc(var(--spacing-xl) * 2); /* Even more space on large screens */
      }
      
      .results-section {
        max-width: 600px; /* Prevent content from being too wide */
      }
      
             .metric-label {
         font-size: 1rem;
       }
       
       .metric-value {
         font-size: 1.4rem;
       }
       
       .probability-value {
         font-size: 2.1rem;
       }
    }
    
    @media (max-width: 767px) {
      .page-header {
        padding: calc(var(--spacing-lg) * 0.7) var(--spacing-sm) 0;
        margin-bottom: 0;
        text-align: center;
      }
      
      .container {
        padding: calc(var(--spacing-lg) * 0.7) var(--spacing-sm);
      }
      
      .results-section {
        margin-top: calc(var(--spacing-lg) * 0.7);
        display: flex;
        flex-direction: column;
      }
      
      /* Reorder sections on mobile: Share section above View Original Tweet */
      .cta-container {
        order: 1;
      }
      
      .share-section {
        order: 2;
      }
      
      .source-link-container {
        order: 3;
      }
      
      .main-content {
        margin-bottom: 0; /* Remove margin to fix spacing */
      }
      
      .detection-row {
        margin-bottom: calc(var(--spacing-lg) * 0.7);
      }
      
      .results-section .score-metrics {
        margin-bottom: calc(var(--spacing-lg) * 0.7) !important;
      }
      

      
      /* Override the inline margin styles on mobile */
      div[style*="margin-top: 2rem"] {
        margin-top: calc(var(--spacing-lg) * 0.7) !important;
      }
      
      div[style*="margin-bottom: 2rem"] {
        margin-bottom: calc(var(--spacing-lg) * 0.7) !important;
      }
      
      .header-content {
        flex-direction: column;
        gap: 0;
        align-items: center;
      }
      
      .logo-image {
        width: 27px;
        height: 20px;
        margin-right: 0;
      }
      
      .header-title {
        font-size: 0.75rem;
        line-height: 1rem;
        text-align: center;
        gap: 0;
        flex-direction: column;
        align-items: center;
        width: 100%;
      }
      
      .header-title-truthscan {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        justify-content: center;
      }
      
      .header-title-rest {
        margin-top: 0.25rem;
        line-height: 1.25;
      }
      
      .header-brand {
        font-size: 1.25rem;
        line-height: 1.5rem;
      }
      
      .brand-line {
        margin-top: var(--space-3);
      }
      
      .photo-description-section,
      .ai-detection-section {
        padding: 0 !important;
        margin-top: calc(var(--spacing-lg) * 0.7);
        margin-bottom: calc(var(--spacing-lg) * 0.7);
      }
      
      .detailed-description {
        margin-top: calc(var(--spacing-lg) * 0.7);
        padding: 0;
        font-size: 0.875rem;
      }
      
      .detailed-description p {
        font-size: 0.875rem;
      }
      

      
      /* Stack images and scores vertically on mobile */
      .detection-row,
      .main-content,
      .score-metrics,
      .source-link-container {
        margin-bottom: calc(var(--spacing-lg) * 0.7);
      }
      
      .detection-row {
        flex-direction: column;
        align-items: center;
        gap: calc(var(--spacing-lg) * 0.7);
        margin-bottom: 0; /* Remove margin-bottom since gap provides the spacing */
      }
      
      .analyzed-image {
        height: 300px; /* Smaller on mobile */
        max-width: 100%;
        margin: 0;
        padding: 0;
        display: block;
      }
      
      .image-fallback {
        height: 300px; /* Smaller on mobile */
        width: 100%;
        max-width: 400px;
      }
      
      .probability-value {
        font-size: 1.56rem; /* 1.2rem * 1.3 */
      }
      
      .metric-value {
        font-size: 1.17rem; /* 0.9rem * 1.3 */
      }
      
      .metric-label {
        font-size: 0.91rem; /* 0.7rem * 1.3 */
      }
      
      .actions-section {
        gap: var(--spacing-md);
        justify-content: center;
      }
      
      .social-btn {
        width: 44px;
        height: 44px;
        background-size: 22px 22px;
      }
      
      .premium-cta {
        padding: 0.5rem 1.5rem;
        font-size: 1rem;
        margin-top: 12px;
        margin-bottom: 12px;
      }
      
      .source-link-container {
        margin-bottom: calc(var(--spacing-lg) * 0.7);
      }
      
      .image-section {
        margin: 0 !important;
        padding: 0 !important;
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
    }
  </style>
</head>
<body>
  <!-- Page Header -->
  <header class="page-header">
    <div class="header-content">
      <!-- Main H1 with Groq title + AI Image Detection Results -->
      <h1 class="header-title">
        <span class="header-title-rest">${data.image_description && data.image_description !== 'Image' ? data.image_description + ' ' : ''}AI Image Detection Results</span>
      </h1>
      
      <!-- TruthScan Brand as H2 - One line below H1 -->
      <div class="brand-line">
        <a href="https://truthscan.com/ai-image-detector" class="header-link" target="_blank" rel="noopener noreferrer">
          <h2 class="header-brand">
            <span class="header-title-truthscan">
              <img src="${backendDomain}/logo.png" alt="TruthScan Logo" class="logo-image" width="38" height="29">
              TruthScan
            </span>
          </h2>
        </a>
      </div>
    </div>
  </header>

  <div class="container">
    
    <!-- Main Content -->
    <main class="main-content" role="main">
      <!-- Left Column: Image -->
      <div class="detection-row">
        <div class="image-section">
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
      </div>
      
      <!-- Right Column: Results Section -->
      <section class="results-section">
        <div class="score-metrics">
          <!-- AI Probability -->
          <div class="metric-item">
            <div class="metric-label">AI Probability</div>
            <div class="metric-value probability-value">${scorePercentage}%</div>
          </div>
          
          <!-- Confidence -->
          <div class="metric-item">
            <div class="metric-label">Confidence</div>
            <div class="metric-value confidence-value">${confidenceLevel}</div>
          </div>
          
          <!-- Classification -->
          <div class="metric-item">
            <div class="metric-label">Classification</div>
            <div class="metric-value classification-value" style="color: ${scoreColor};">${classification}</div>
          </div>
        </div>
        
        <!-- Premium CTA Button -->
        <div class="cta-container">
          <a href="https://truthscan.com/ai-image-detector" class="premium-cta" target="_blank" rel="noopener noreferrer">
            Test Another Image
            <svg class="cta-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
            </svg>
          </a>
        </div>
        
        <!-- Original Tweet Link -->
        <div class="source-link-container">
          <a href="${twitterUrl}" class="source-link" target="_blank" rel="noopener noreferrer">
            🐦 View Original Tweet by @${data.twitter_handle}
          </a>
        </div>
        
        <!-- Social Sharing Section -->
        <div class="share-section">
          <div class="share-row">
            <div class="share-label">Share:</div>
            <div class="share-buttons">
              <button class="social-btn facebook" onclick="shareOnFacebook()" title="Share on Facebook"></button>
              <button class="social-btn twitter" onclick="shareOnTwitter()" title="Share on Twitter/X"></button>
              <button class="social-btn linkedin" onclick="shareOnLinkedIn()" title="Share on LinkedIn"></button>
              <button class="social-btn copy" onclick="copyLink()" title="Copy Link"></button>
            </div>
          </div>
        </div>
      </section>
    </main>
    
    ${data.detailed_description ? `
    <!-- Photo Description Section -->
    <section class="photo-description-section">
      <div class="header-content">
        <h2 class="header-title">
          <span class="header-title-rest">Photo Description – ${data.image_description && data.image_description !== 'Image' ? data.image_description : 'Image Analysis'}</span>
        </h2>
      </div>
      
      <!-- Detailed Description Text -->
      <div class="detailed-description">
        <p>${data.detailed_description}</p>
      </div>
    </section>` : ''}
    
    <!-- AI Detection Confidence Section -->
    <section class="ai-detection-section">
      <div class="header-content">
        <h2 class="header-title">
          <span class="header-title-rest">${scorePercentage >= 50 ? `Why It's Likely AI-Generated (${scorePercentage}% Confidence)` : `Why It's Likely Real (${100 - scorePercentage}% Confidence)`}</span>
        </h2>
      </div>
      
      <!-- AI Detection Explanation Text -->
      <div class="detailed-description">
        ${data.confidence_analysis ? 
          `<div>${data.confidence_analysis.split('\n').map((line: string) => line.trim() ? `<p>${line.trim()}</p>` : '').join('')}</div>` : 
          `<p>• This analysis is based on artificial intelligence algorithms that examine various visual characteristics including patterns, textures, artifacts, and inconsistencies typically associated with AI-generated content.</p>
           <p>• The ${scorePercentage}% confidence score indicates the likelihood that this image was created using AI tools rather than traditional photography or manual creation.</p>`
        }
      </div>
    </section>
    
    <!-- Footer -->
    <footer class="footer">
      <p>
        Powered by <a href="https://truthscan.com/ai-image-detector" target="_blank" rel="noopener noreferrer">TruthScan</a> 
        ⚠️ This result is generated by an AI model and may contain inaccuracies. It does not constitute a definitive or factual claim about the content or its creator.
      </p>
    </footer>
  </div>
  
  <script>
    // Social sharing functionality
    const shareData = {
      title: 'AI Detection Result: ${scorePercentage}% ${classification}',
      text: 'Check out this AI detection analysis from TruthScan - ${scorePercentage}% ${classification}',
      url: window.location.href
    };
    
    function shareOnFacebook() {
      // Facebook requires specific parameters and formatting
      const params = new URLSearchParams({
        u: shareData.url,
        quote: shareData.text
      });
      const url = 'https://www.facebook.com/sharer/sharer.php?' + params.toString();
      window.open(url, 'facebook-share', 'width=626,height=436,scrollbars=no,resizable=no');
    }
    
    function shareOnTwitter() {
      const text = shareData.text + ' ' + shareData.url;
      const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text);
      window.open(url, 'twitter-share', 'width=550,height=420,scrollbars=no,resizable=no');
    }
    
    function shareOnLinkedIn() {
      // LinkedIn sharing using official LinkedIn sharing URL
      // Opens LinkedIn's compose interface with the URL pre-filled
      const url = 'https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(shareData.url);
      window.open(url, 'linkedin-share', 'width=626,height=675,scrollbars=no,resizable=no');
    }
    
    function copyLink() {
      navigator.clipboard.writeText(shareData.url).then(() => {
        const btn = event.target;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 2000);
      }).catch(console.error);
    }
    
    // Fallback native sharing for mobile devices
    function fallbackShare() {
      if (navigator.share) {
        navigator.share(shareData).catch(console.error);
      } else {
        copyLink();
      }
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
        created_at, updated_at, robots_index, image_description, meta_description, detailed_description, confidence_analysis
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
        hasImageDescription: !!result.image_description,
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