export type SourceType = "official_web" | "official_api" | "official_document" | "manual_verified";

export type HttpMethod = "GET" | "POST";

export interface FetchPolicy {
  /** 允許的 HTTP 方法；請求內容由 adapter 產生，不接受外部輸入。 */
  methods: HttpMethod[];
  timeoutMs: number;
  maxResponseBytes: number;
  acceptedContentTypes: string[];
  userAgent: string;
  followRedirects: boolean;
  maxRedirects: number;
  /** 同一來源兩個請求之間至少間隔多久（對學校網站保持禮貌）。 */
  minIntervalMs: number;
}

/** 某個 entrypoint 允許的查詢參數，每個參數都必須完全符合對應的格式。 */
export type QueryRules = Record<string, Record<string, RegExp>>;

/** 學校 Strapi 公告（new.ntpu.edu.tw 的處室公告）。 */
export interface StrapiPublicationsConfig {
  kind: "strapi-publications";
  /** sitesApproved 的值，例如研發處為 ord_ntpu。 */
  siteKey: string;
}

/** 學校 Strapi 的固定內容頁（sections），以頁面路徑指定。 */
export interface StrapiSectionsConfig {
  kind: "strapi-sections";
  /** 頁面路徑，例如 /president；公開網址是 https://new.ntpu.edu.tw + 路徑。 */
  pagePaths: string[];
}

/** 伺服器端產生的 HTML 公告網站：列表頁翻頁，再逐則抓內文。 */
export interface HtmlNewsConfig {
  kind: "html-news";
  site: "library-ewpt" | "lc-jsp";
  /** 每次執行最多抓幾則內文；其餘留到下一次（避免超過單次執行的子請求上限）。 */
  maxDetailsPerRun: number;
  /** 內文多久沒重新驗證就要重抓。 */
  reverifyAfterSeconds: number;
  /** 疑似含個人資料（遮罩姓名名單）的公告不收錄，記入隔離區。 */
  personalDataGuard: boolean;
}

export type AdapterConfig = StrapiPublicationsConfig | StrapiSectionsConfig | HtmlNewsConfig;

export interface SourceDefinition {
  id: string;
  sourceUnit: string;
  sourceType: SourceType;
  trustLevel: "official" | "verified" | "secondary";
  /** 給人看的官方頁面，provenance 與 sources 表使用。 */
  homepageUrl: string;
  /** 公告的公開頁面前綴；strapi 公告的官方連結是「前綴/_id」。 */
  newsUrlBase: string;

  origin: string;
  allowedPathPrefixes: string[];
  entrypoints: string[];
  /** entrypoint → 允許的查詢參數；沒列出的 entrypoint 不得帶任何查詢參數。 */
  queryRules?: QueryRules;

  parser: AdapterConfig["kind"];
  adapter: AdapterConfig;
  entityType: "announcement" | "page";
  enabled: boolean;

  fetch: FetchPolicy;
  freshness: {
    /** 說明用；實際由 cron 每 10 分鐘挑一個到期的來源。 */
    schedule: string;
    maxStalenessSeconds: number;
  };
}

/** 一次要送出的請求，由 adapter 產生；path 必須是 entrypoints 之一，query 必須符合 queryRules。 */
export interface SourceRequest {
  target: string;
  path: string;
  query?: Record<string, string>;
  method?: HttpMethod;
  body?: string;
  contentType?: "application/json" | "application/x-www-form-urlencoded";
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
