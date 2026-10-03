export type SourceType = "official_web" | "official_api" | "official_document" | "manual_verified";

export interface FetchPolicy {
  /** strapi GraphQL 只接受 POST；請求內容由 parser adapter 產生，不接受外部輸入。 */
  method: "GET" | "POST";
  timeoutMs: number;
  maxResponseBytes: number;
  acceptedContentTypes: string[];
  userAgent: string;
  followRedirects: boolean;
  maxRedirects: number;
}

export interface SourceDefinition {
  id: string;
  sourceUnit: string;
  sourceType: SourceType;
  trustLevel: "official" | "verified" | "secondary";
  /** 給人看的官方頁面，provenance 與 sources 表使用。 */
  homepageUrl: string;

  origin: string;
  allowedPathPrefixes: string[];
  entrypoints: string[];

  parser: string;
  entityType: string;
  enabled: boolean;

  /** strapi 的站台代碼，例如研發處為 ord_ntpu。 */
  strapiSiteKey?: string;

  fetch: FetchPolicy;
  freshness: {
    /** Cron 以 UTC 解讀。 */
    schedule: string;
    maxStalenessSeconds: number;
  };
}

/** 一次要送出的請求，由 parser adapter 產生；path 必須是 entrypoints 之一。 */
export interface SourceRequest {
  target: string;
  path: string;
  body?: string;
}

export interface RawSnapshot {
  sourceId: string;
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  httpStatus: number;
  contentType: string | null;
  headers: Record<string, string>;
  requestBody: string | null;
  bytes: Uint8Array;
  rawHash: string;
}

export interface ArchivedRawSnapshot {
  key: string;
  rawHash: string;
}

export interface RawArchive {
  put(snapshot: RawSnapshot): Promise<ArchivedRawSnapshot>;
}

export type FetchLike = (input: Request) => Promise<Response>;
