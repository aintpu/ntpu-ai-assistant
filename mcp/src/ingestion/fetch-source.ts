import type { Clock } from "../shared/clock";
import { IngestionError } from "../shared/errors";
import { sha256Hex } from "../shared/hash";
import { assertManualPath, MANUAL_PREFIX } from "./manual-inbox";
import { assertUrlAllowed, resolveRequestUrl } from "./url-policy";
import { isManualSource, type FetchLike, type ManualInbox, type RawSnapshot, type SourceDefinition, type SourceRequest } from "./types";

/** 只保留這些回應標頭到原始檔的 metadata，避免存入 cookie 等資料。 */
const SAFE_HEADERS = ["content-type", "content-length", "etag", "last-modified", "date", "cache-control"];

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new IngestionError("FETCH_TOO_LARGE", `response declares ${declared} bytes > ${maxBytes}`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new IngestionError("FETCH_TOO_LARGE", `response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * 人工整理檔：從 R2 manual/ 讀取，不連任何網站。只能讀來源登記的 entrypoint，
 * 並套用同樣的大小與 content-type 限制；之後一樣存原始檔、雜湊、比對版本。
 */
async function readManual(
  source: SourceDefinition,
  request: SourceRequest,
  deps: { clock: Clock; manual?: ManualInbox },
): Promise<RawSnapshot> {
  if (!source.entrypoints.includes(request.path) || request.query || request.body) {
    throw new IngestionError("URL_NOT_ALLOWED", `manual file is not registered: ${request.path}`);
  }
  assertManualPath(request.path);
  if (!deps.manual) throw new IngestionError("DEPENDENCY_UNAVAILABLE", "manual inbox is not configured");
  const file = await deps.manual.get(request.path);
  if (!file) throw new IngestionError("FETCH_HTTP_ERROR", `manual file not uploaded: ${request.path}`);
  if (file.bytes.byteLength > source.fetch.maxResponseBytes) {
    throw new IngestionError("FETCH_TOO_LARGE", `manual file exceeds ${source.fetch.maxResponseBytes} bytes`);
  }
  const mediaType = (file.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!source.fetch.acceptedContentTypes.includes(mediaType)) {
    throw new IngestionError("CONTENT_TYPE_REJECTED", `content type not accepted: ${mediaType || "(none)"}`);
  }
  const location = `r2:${MANUAL_PREFIX}${request.path}`;
  return {
    sourceId: source.id,
    requestedUrl: location,
    finalUrl: location,
    fetchedAt: deps.clock.nowIso(),
    httpStatus: 200,
    contentType: file.contentType,
    headers: {},
    requestBody: null,
    bytes: file.bytes,
    rawHash: await sha256Hex(file.bytes),
  };
}

/**
 * 依來源設定抓一個 entrypoint（規格 06 §7–8）。呼叫端只能指定 entrypoint，
 * 不能指定網址；轉址也必須通過同一套檢查。
 */
export async function fetchSource(
  source: SourceDefinition,
  request: SourceRequest,
  deps: { fetch: FetchLike; clock: Clock; manual?: ManualInbox },
): Promise<RawSnapshot> {
  if (isManualSource(source)) return readManual(source, request, deps);
  const policy = source.fetch;
  let url = resolveRequestUrl(source, request);
  const method = request.method ?? policy.methods[0]!;
  if (!policy.methods.includes(method)) {
    throw new IngestionError("URL_NOT_ALLOWED", `method not allowed: ${method}`);
  }
  const requestedUrl = url.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      const init: RequestInit = {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": policy.userAgent,
          Accept: policy.acceptedContentTypes.join(", "),
          ...(request.body ? { "Content-Type": request.contentType ?? "application/json" } : {}),
        },
        ...(method === "POST" && request.body ? { body: request.body } : {}),
      };
      try {
        response = await deps.fetch(new Request(url, init));
      } catch (err) {
        if (controller.signal.aborted) {
          throw new IngestionError("FETCH_TIMEOUT", `timed out after ${policy.timeoutMs}ms`);
        }
        throw new IngestionError("DEPENDENCY_UNAVAILABLE", `network error: ${(err as Error).message}`);
      }
      if (response.status < 300 || response.status >= 400) break;

      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!policy.followRedirects || redirects >= policy.maxRedirects || !location) {
        throw new IngestionError("REDIRECT_REJECTED", `redirect ${response.status} not allowed`);
      }
      const next = new URL(location, url);
      try {
        assertUrlAllowed(next, source);
      } catch (err) {
        const code = (err as IngestionError).code === "SSRF_BLOCKED" ? "SSRF_BLOCKED" : "REDIRECT_REJECTED";
        throw new IngestionError(code, `redirect target rejected: ${(err as Error).message}`);
      }
      url = next;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new IngestionError("FETCH_HTTP_ERROR", `HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type");
    const mediaType = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (!policy.acceptedContentTypes.includes(mediaType)) {
      await response.body?.cancel();
      throw new IngestionError("CONTENT_TYPE_REJECTED", `content type not accepted: ${mediaType || "(none)"}`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, policy.maxResponseBytes);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new IngestionError("FETCH_TIMEOUT", `timed out after ${policy.timeoutMs}ms`);
      }
      throw err;
    }

    const headers: Record<string, string> = {};
    for (const name of SAFE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }

    return {
      sourceId: source.id,
      requestedUrl,
      finalUrl: url.toString(),
      fetchedAt: deps.clock.nowIso(),
      httpStatus: response.status,
      contentType,
      headers,
      requestBody: request.body ?? null,
      bytes,
      rawHash: await sha256Hex(bytes),
    };
  } finally {
    clearTimeout(timer);
  }
}
