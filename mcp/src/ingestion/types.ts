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
/**
 * 個資過濾模式：off 全部收錄；student-ids 只擋含學號的名單；all 連姓名名單也擋。
 */
export type PersonalDataGuard = "off" | "student-ids" | "all";

export type QueryRules = Record<string, Record<string, RegExp>>;

/** 學校 Strapi 公告（new.ntpu.edu.tw 的處室公告）。 */
export interface StrapiPublicationsConfig {
  kind: "strapi-publications";
  /** sitesApproved 的值，例如研發處為 ord_ntpu。 */
  siteKey: string;
  /** 疑似含個人資料的公告不收錄，記入隔離區（見 PersonalDataGuard）。 */
  personalDataGuard: PersonalDataGuard;
}

/** 學校 Strapi 的內容頁（sections）：以頁面路徑逐一指定，或以路徑前綴抓整個處室站台的所有頁面。 */
export interface StrapiSectionsConfig {
  kind: "strapi-sections";
  /** 頁面路徑，例如 /president；公開網址是 https://new.ntpu.edu.tw + 路徑。 */
  pagePaths?: string[];
  /** 路徑前綴，例如 /osa/：抓這個前綴下所有有內容的頁面（翻頁到底）。與 pagePaths 擇一。 */
  pathPrefix?: string;
}

/** 伺服器端產生的 HTML 公告網站：列表頁翻頁，再逐則抓內文。 */
export interface HtmlNewsConfig {
  kind: "html-news";
  site: "library-ewpt" | "lc-jsp";
  /** 每次執行最多抓幾則內文；其餘留到下一次（避免超過單次執行的子請求上限）。 */
  maxDetailsPerRun: number;
  /** 內文多久沒重新驗證就要重抓。 */
  reverifyAfterSeconds: number;
  /** 疑似含個人資料的公告不收錄，記入隔離區（見 PersonalDataGuard）。 */
  personalDataGuard: PersonalDataGuard;
}

/**
 * 人工整理檔（repo 的 crawler_data/，上傳到 R2 的 manual/ 後由抓取 Worker 讀取）。
 * 檔案路徑都必須列在 entrypoints；不會連到任何網站。
 */
/** 一個處室的法規全文檔，並以「正規化標題」配對法規彙整表，補上官方檔案連結與標籤。 */
export interface ManualRegulationsConfig {
  kind: "manual-regulations";
  /** 法規全文 markdown（## 法規名稱 → 內文）。 */
  fullTextFile: string;
  /** upload-manual 由兩份法規彙整 xlsx 轉出的 JSON。 */
  catalogFile: string;
  /** 彙整表裡屬於本處室的「所屬單位／處室」名稱；彙整表有、全文檔沒有的法規也一併收錄（只有目錄）。 */
  catalogOwners: string[];
}

/** 法規彙整表裡沒有全文檔的單位（學院、研究中心、其他處室）：只有目錄與官方連結。 */
export interface ManualRegulationCatalogConfig {
  kind: "manual-regulation-catalog";
  catalogFile: string;
  /** 已由 manual-regulations 來源收錄的單位，這裡跳過，避免同一份法規出現兩次。 */
  excludeOwners: string[];
}

/** 各處室常見問答 markdown（### 問題 → 回答 → 欄位）。 */
export interface ManualFaqConfig {
  kind: "manual-faq";
  files: { file: string; unit: string }[];
}

export type ManualAdapterConfig = ManualRegulationsConfig | ManualRegulationCatalogConfig | ManualFaqConfig;

export type AdapterConfig =
  | StrapiPublicationsConfig
  | StrapiSectionsConfig
  | HtmlNewsConfig
  | ManualAdapterConfig;

export const MANUAL_ADAPTER_KINDS: readonly ManualAdapterConfig["kind"][] = [
  "manual-regulations",
  "manual-regulation-catalog",
  "manual-faq",
];

export function isManualSource(source: Pick<SourceDefinition, "adapter">): boolean {
  return (MANUAL_ADAPTER_KINDS as readonly string[]).includes(source.adapter.kind);
}

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
  entityType: EntityType;
  /**
   * 一個來源的資料分屬多個處室時（例如各處室 FAQ 合成一個來源），列出這些處室；
   * 每筆資料的處室由 adapter 給。沒列的話，資料都屬於 sourceUnit。
   */
  recordUnits?: string[];
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

export type EntityType = "announcement" | "page" | "regulation" | "faq";

/** 人工整理檔的存放處（R2 的 manual/ 前綴）。只能讀，key 必須是來源登記的 entrypoint。 */
export interface ManualInbox {
  get(path: string): Promise<{ bytes: Uint8Array; contentType: string | null } | null>;
}
