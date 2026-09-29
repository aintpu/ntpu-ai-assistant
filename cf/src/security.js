// 所有回應共用的安全標頭。
//
// CSP 不使用 unsafe-inline 關鍵字：Next.js 靜態輸出中的 inline <script>／<style> 由
// cf/scripts/generate-csp-hashes.mjs 在每次 wrangler deploy 前計算 sha256，
// 以 hash 個別授權（見 csp-hashes.generated.js）。
const CLOUDFLARE_INSIGHTS_SCRIPT = "https://static.cloudflareinsights.com";

export function buildContentSecurityPolicy({ scriptHashes = [], styleHashes = [] } = {}) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ["script-src 'self'", ...scriptHashes, CLOUDFLARE_INSIGHTS_SCRIPT].join(" "),
    ["style-src 'self'", ...styleHashes].join(" "),
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://cloudflareinsights.com https://*.cloudflareinsights.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

// 沒有 hash 時的 CSP：任何 inline script／style 都會被擋（fail closed）。
const DEFAULT_CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

const SECURITY_HEADERS = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)",
});

export function withSecurityHeaders(response, contentSecurityPolicy = DEFAULT_CONTENT_SECURITY_POLICY) {
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
    headers.set("Content-Security-Policy", contentSecurityPolicy);
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

export { DEFAULT_CONTENT_SECURITY_POLICY as CONTENT_SECURITY_POLICY, SECURITY_HEADERS };
