export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    
    // Handle detection pages: /d/{id}
    const detectionMatch = incomingUrl.pathname.match(/^\/d\/([\w-]+)$/);
    
    // Handle thumbnail requests: /thumbnails/{id}
    const thumbnailMatch = incomingUrl.pathname.match(/^\/thumbnails\/([\w-]+)$/);
    
    // Handle image requests: /images/{id}
    const imageMatch = incomingUrl.pathname.match(/^\/images\/([\w-]+)$/);

    if (!detectionMatch && !thumbnailMatch && !imageMatch) {
      return new Response("Not found", { status: 404 });
    }

    const backendBase = "https://truthscan-twitter-bot.bjuhasz08.workers.dev";
    let targetUrl;
    
    if (detectionMatch) {
      const id = detectionMatch[1];
      targetUrl = `${backendBase}/d/${id}`;
    } else if (thumbnailMatch) {
      const id = thumbnailMatch[1];
      targetUrl = `${backendBase}/thumbnails/${id}`;
    } else if (imageMatch) {
      const id = imageMatch[1];
      targetUrl = `${backendBase}/images/${id}`;
    }

    const originResponse = await fetch(targetUrl);
    const contentType = originResponse.headers.get("Content-Type") || "";

    if (contentType.includes("text/html")) {
      return new HTMLRewriter()
        .on("meta[property='og:image']", new MetaTagRewriter(backendBase))
        .on("meta[property='og:image:secure_url']", new MetaTagRewriter(backendBase))
        .on("meta[name='twitter:image']", new MetaTagRewriter(backendBase))
        .transform(originResponse);
    }

    // For non-HTML (e.g. images, JSON), stream the original response as-is
    // Make sure to preserve all headers for images (especially cache headers)
    return new Response(originResponse.body, {
      status: originResponse.status,
      headers: originResponse.headers,
    });
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