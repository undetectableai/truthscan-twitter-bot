export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    const backendBase = "https://truthscan-twitter-bot.bjuhasz08.workers.dev";
    
    // Build the target URL by forwarding the entire path and query parameters
    const targetUrl = `${backendBase}${incomingUrl.pathname}${incomingUrl.search}`;
    
    // Prepare request options
    const requestOptions = {
      method: request.method,
      headers: request.headers
    };
    
    // Only include body for non-GET/HEAD requests
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      requestOptions.body = request.body;
    }
    
    try {
      // Forward the request to the backend
      const originResponse = await fetch(targetUrl, requestOptions);
      
      const contentType = originResponse.headers.get("Content-Type") || "";

      // Only apply HTML rewriting for detection pages that return HTML
      const isDetectionPage = incomingUrl.pathname.match(/^\/d\/([\w-]+)$/);
      
      if (isDetectionPage && contentType.includes("text/html")) {
        // Apply HTML rewriting for social media meta tags on detection pages
        return new HTMLRewriter()
          .on("meta[property='og:image']", new MetaTagRewriter(backendBase))
          .on("meta[property='og:image:secure_url']", new MetaTagRewriter(backendBase))
          .on("meta[name='twitter:image']", new MetaTagRewriter(backendBase))
          .transform(originResponse);
      }

      // For all other requests (dashboard, logo, images, etc.), stream the original response as-is
      // Make sure to preserve all headers
      return new Response(originResponse.body, {
        status: originResponse.status,
        headers: originResponse.headers,
      });
    } catch (error) {
      console.error('Proxy error:', error);
      return new Response('Proxy Error: ' + error.message, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
}

class MetaTagRewriter {
  constructor(backendBase) {
    this.backendBase = backendBase;
  }

  element(element) {
    const content = element.getAttribute("content");
    if (content && content.startsWith("/")) {
      element.setAttribute("content", `${this.backendBase}${content}`);
    }
  }
} 