const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://cloudflareinsights.com https://*.cloudflareinsights.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)",
});

export function withSecurityHeaders(response) {
  // WebSocket upgrades (101) carry a `webSocket` handle that a rebuilt Response
  // would drop, and the Response constructor rejects status 101. Pass through.
  if (response.status === 101 || response.webSocket) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  const contentType = headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("text/html")) {
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function redirectProductionHttp(request) {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || url.hostname !== "aia.ntpu.ai") {
    return null;
  }
  url.protocol = "https:";
  return withSecurityHeaders(Response.redirect(url.toString(), 308));
}

export { CONTENT_SECURITY_POLICY, SECURITY_HEADERS };
