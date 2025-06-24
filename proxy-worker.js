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

    let targetUrl;
    
    if (detectionMatch) {
      const id = detectionMatch[1];
      targetUrl = `https://truthscan-twitter-bot.bjuhasz08.workers.dev/d/${id}`;
    } else if (thumbnailMatch) {
      const id = thumbnailMatch[1];
      targetUrl = `https://truthscan-twitter-bot.bjuhasz08.workers.dev/thumbnails/${id}`;
    } else if (imageMatch) {
      const id = imageMatch[1];
      targetUrl = `https://truthscan-twitter-bot.bjuhasz08.workers.dev/images/${id}`;
    }

    const originResponse = await fetch(targetUrl);
    const contentType = originResponse.headers.get("Content-Type") || "";

    if (contentType.includes("text/html")) {
      let body = await originResponse.text();

      // Rewrite relative src/href URLs to absolute pointing to backend origin
      body = body.replace(/(src|href)="\/([^"]+)"/g, (full, attr, path) => {
        return `${attr}="https://truthscan-twitter-bot.bjuhasz08.workers.dev/${path}"`;
      });

      return new Response(body, {
        status: originResponse.status,
        headers: {
          "Content-Type": contentType,
        },
      });
    }

    // For non-HTML (e.g. images, JSON), stream the original response as-is
    // Make sure to preserve all headers for images (especially cache headers)
    return new Response(originResponse.body, {
      status: originResponse.status,
      headers: originResponse.headers,
    });
  },
}; 