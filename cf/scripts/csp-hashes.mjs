// 從 Next.js 靜態輸出的 HTML 萃取 inline <script>／<style> 並計算 CSP hash。
// 由 generate-csp-hashes.mjs（wrangler build）與測試共用。
import { createHash } from "node:crypto";

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_RE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
const HAS_SRC_RE = /\ssrc\s*=/i;
const NON_JS_TYPE_RE = /\stype\s*=\s*["']?(?!text\/javascript|module|application\/javascript)[^"'\s>]+/i;

export function cspHash(text) {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

// 瀏覽器對 inline script/style 的 hash 是對元素的原始文字內容（UTF-8）計算，
// HTML 的 raw text element 不做 entity 解碼，因此直接取標籤之間的字串即可。
export function extractInline(html) {
  const scripts = [];
  const styles = [];
  for (const [, attrs, body] of html.matchAll(SCRIPT_RE)) {
    if (HAS_SRC_RE.test(attrs)) continue;              // 外部 script 由 'self' 允許
    if (NON_JS_TYPE_RE.test(attrs)) continue;          // JSON 等資料區塊不會被執行
    scripts.push(body);
  }
  for (const [, , body] of html.matchAll(STYLE_RE)) styles.push(body);
  return { scripts, styles };
}

// 找出 CSP（不含 'unsafe-inline'／'unsafe-hashes'）一定會擋掉、hash 也救不了的寫法。
export function findBlockedInlineAttributes(html) {
  const markup = html.replace(SCRIPT_RE, "<script></script>").replace(STYLE_RE, "<style></style>");
  const problems = [];
  const TAG_RE = /<([a-zA-Z][\w:-]*)(\s[^<>]*?)?>/g;
  for (const [tag, name, attrs = ""] of markup.matchAll(TAG_RE)) {
    if (/\sstyle\s*=/i.test(attrs)) problems.push(`style attribute on <${name}>: ${tag.slice(0, 120)}`);
    const handler = attrs.match(/\s(on[a-z]+)\s*=/i);
    if (handler) problems.push(`inline event handler ${handler[1]} on <${name}>`);
    if (/\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i.test(attrs)) {
      problems.push(`javascript: URL on <${name}>`);
    }
  }
  return problems;
}
