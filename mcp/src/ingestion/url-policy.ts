import { IngestionError } from "../shared/errors";
import { MANUAL_PATH } from "./manual-inbox";
import { isManualSource, type SourceDefinition, type SourceRequest } from "./types";

const ADAPTER_KINDS = ["strapi-publications", "strapi-sections", "html-news", "attachments", "strapi-officials"];

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function isDeniedIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / 雲端 metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a! >= 224 // multicast / reserved
  );
}

/**
 * 拒絕 loopback、私有網段、link-local、metadata 主機（規格 06 §8.1）。
 * Workers 不提供 DNS 解析結果，因此另外以 allowlist 限定主機名稱；
 * 只要主機名稱不是設定裡的那一個就不會送出請求。
 */
export function isDeniedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;
  if (METADATA_HOSTS.has(host)) return true;
  const v4 = parseIpv4(host);
  if (v4) return isDeniedIpv4(v4);
  if (host.includes(":")) {
    // 任何 IPv6 位址都不是我們的來源；一律拒絕（含 ::1、fe80::、fc00::、::ffff:127.0.0.1）。
    return true;
  }
  // 只由數字組成的主機（例如 2130706433 = 127.0.0.1）也拒絕。
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  return false;
}

/** 檢查一個網址是否落在來源允許的範圍內，不合規就丟出 IngestionError。 */
export function assertUrlAllowed(url: URL, source: SourceDefinition): void {
  const origin = new URL(source.origin);
  if (url.protocol !== "https:") {
    throw new IngestionError("URL_NOT_ALLOWED", `scheme not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new IngestionError("URL_NOT_ALLOWED", "credentials in URL are not allowed");
  }
  if (isDeniedHost(url.hostname)) {
    throw new IngestionError("SSRF_BLOCKED", `destination blocked: ${url.hostname}`);
  }
  if (url.hostname !== origin.hostname || url.port !== origin.port) {
    throw new IngestionError("URL_NOT_ALLOWED", `host not in allowlist: ${url.host}`);
  }
  const path = url.pathname;
  const allowed = source.allowedPathPrefixes.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
  if (!allowed) {
    throw new IngestionError("URL_NOT_ALLOWED", `path not in allowlist: ${path}`);
  }
}

/** 由來源設定與 entrypoint 組出網址；不接受任何外部提供的完整網址。 */
export function resolveEntrypoint(source: SourceDefinition, path: string): URL {
  return resolveRequestUrl(source, { path });
}

/**
 * 組出一個請求的網址：path 必須是登記的 entrypoint，查詢參數必須逐一符合 queryRules
 * （例如內文頁的編號格式），沒有規則的 entrypoint 不得帶任何參數。
 */
export function resolveRequestUrl(source: SourceDefinition, request: Pick<SourceRequest, "path" | "query">): URL {
  const { path, query } = request;
  const dynamic = !source.entrypoints.includes(path) && (source.pathRules ?? []).some((rule) => rule.test(path));
  if (!source.entrypoints.includes(path) && !dynamic) {
    throw new IngestionError("URL_NOT_ALLOWED", `entrypoint not registered: ${path}`);
  }
  const url = new URL(path, source.origin);
  if (url.pathname !== path || url.search || url.hash) {
    throw new IngestionError("URL_NOT_ALLOWED", `entrypoint is not a plain path: ${path}`);
  }
  const rules = source.queryRules?.[path] ?? {};
  for (const [name, value] of Object.entries(query ?? {})) {
    const rule = rules[name];
    if (!rule?.test(value)) {
      throw new IngestionError("URL_NOT_ALLOWED", `query parameter not allowed: ${name}`);
    }
    url.searchParams.set(name, value);
  }
  assertUrlAllowed(url, source);
  return url;
}

/**
 * 人工整理檔來源：不連網站，只讀 R2 manual/ 裡登記過的檔案。
 * 檢查來源類型、可信度、檔案路徑，以及 adapter 讀的檔案都在 entrypoints 裡。
 */
function validateManualSource(source: SourceDefinition, fail: (why: string) => never): void {
  if (source.sourceType !== "manual_verified") fail("manual source must be manual_verified");
  if (source.trustLevel !== "verified") fail("manual source must have trustLevel verified");
  if (source.entrypoints.length === 0) fail("entrypoints is empty");
  for (const path of source.entrypoints) {
    if (!MANUAL_PATH.test(path) || path.includes("..")) fail(`manual file path not allowed: ${path}`);
  }
  if (source.queryRules && Object.keys(source.queryRules).length > 0) fail("manual source must not have queryRules");
  const cfg = source.adapter;
  const files =
    cfg.kind === "manual-regulations"
      ? [cfg.fullTextFile, cfg.catalogFile]
      : cfg.kind === "manual-regulation-catalog"
        ? [cfg.catalogFile]
        : cfg.kind === "manual-faq"
          ? cfg.files.map((f) => f.file)
          : [];
  if (files.length === 0) fail("manual adapter reads no files");
  for (const file of files) {
    if (!source.entrypoints.includes(file)) fail(`adapter file not in entrypoints: ${file}`);
  }
  if (source.parser !== cfg.kind) fail(`unknown parser: ${source.parser}`);
  const f = source.fetch;
  if (f.methods.length !== 1 || f.methods[0] !== "GET") fail("manual source methods must be GET only");
  if (!(f.maxResponseBytes > 0 && f.maxResponseBytes <= 10 * 1024 * 1024)) fail("maxResponseBytes missing or too large");
  if (f.acceptedContentTypes.length === 0) fail("acceptedContentTypes is empty");
  if (f.followRedirects || f.maxRedirects !== 0) fail("manual source must not follow redirects");
  if (!(source.freshness.maxStalenessSeconds > 0)) fail("maxStalenessSeconds missing");
  try {
    if (new URL(source.homepageUrl).protocol !== "https:") fail("homepageUrl must be https");
  } catch {
    fail("homepageUrl is not a URL");
  }
}

export function validateSourceDefinition(source: SourceDefinition): void {
  const fail = (why: string): never => {
    throw new Error(`invalid source ${source.id}: ${why}`);
  };
  if (isManualSource(source)) {
    validateManualSource(source, fail);
    return;
  }
  let origin: URL;
  try {
    origin = new URL(source.origin);
  } catch {
    throw new Error(`invalid source ${source.id}: origin is not a URL`);
  }
  if (origin.protocol !== "https:") fail("origin must be https");
  if (origin.username || origin.password) fail("origin must not contain credentials");
  if (!origin.hostname) fail("origin hostname is blank");
  if (origin.pathname !== "/" || origin.search || origin.hash) fail("origin must not contain a path");
  if (isDeniedHost(origin.hostname)) fail("origin host is denied");
  if (source.allowedPathPrefixes.length === 0) fail("allowedPathPrefixes is empty");
  for (const prefix of source.allowedPathPrefixes) {
    if (!prefix.startsWith("/") || prefix === "/" || prefix.includes("*")) {
      fail(`path prefix too broad: ${prefix}`);
    }
  }
  if (source.entrypoints.length === 0) fail("entrypoints is empty");
  for (const path of source.entrypoints) {
    try {
      resolveEntrypoint(source, path);
    } catch (err) {
      fail(`entrypoint ${path}: ${(err as Error).message}`);
    }
  }
  const f = source.fetch;
  if (!(f.timeoutMs > 0 && f.timeoutMs <= 60_000)) fail("timeoutMs missing or too large");
  if (!(f.maxResponseBytes > 0 && f.maxResponseBytes <= 50 * 1024 * 1024)) {
    fail("maxResponseBytes missing or too large");
  }
  if (f.acceptedContentTypes.length === 0) fail("acceptedContentTypes is empty");
  if (f.maxRedirects < 0 || f.maxRedirects > 5) fail("maxRedirects out of range");
  if (!ADAPTER_KINDS.includes(source.parser) || source.adapter?.kind !== source.parser) {
    fail(`unknown parser: ${source.parser}`);
  }
  if (f.methods.length === 0 || f.methods.some((m) => m !== "GET" && m !== "POST")) fail("methods invalid");
  if (!(f.minIntervalMs >= 0 && f.minIntervalMs <= 10_000)) fail("minIntervalMs out of range");
  for (const rule of source.pathRules ?? []) {
    if (!rule.source.startsWith("^") || !rule.source.endsWith("$")) fail("path rule must be anchored");
    if (rule.flags.includes("g") || rule.flags.includes("y")) fail("path rule must not be global or sticky");
  }
  for (const [path, params] of Object.entries(source.queryRules ?? {})) {
    if (!source.entrypoints.includes(path)) fail(`queryRules for unknown entrypoint: ${path}`);
    for (const [name, rule] of Object.entries(params)) {
      if (!rule.source.startsWith("^") || !rule.source.endsWith("$")) fail(`query rule ${name} must be anchored`);
    }
  }
  if (!(source.freshness.maxStalenessSeconds > 0)) fail("maxStalenessSeconds missing");
  try {
    const home = new URL(source.homepageUrl);
    if (home.protocol !== "https:") fail("homepageUrl must be https");
  } catch {
    fail("homepageUrl is not a URL");
  }
  // 公告連結會原樣回給使用者，只允許學校網域的 https 網址。
  let news: URL | null = null;
  try {
    news = new URL(source.newsUrlBase);
  } catch {
    fail("newsUrlBase is not a URL");
  }
  if (news!.protocol !== "https:" || !news!.hostname.endsWith(".ntpu.edu.tw") || source.newsUrlBase.endsWith("/")) {
    fail("newsUrlBase must be an https ntpu.edu.tw URL without a trailing slash");
  }
}
