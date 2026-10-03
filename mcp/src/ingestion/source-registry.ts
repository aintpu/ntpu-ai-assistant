import { validateSourceDefinition } from "./url-policy";
import type { FetchPolicy, PersonalDataGuard, SourceDefinition } from "./types";

const USER_AGENT = "NTPU-AIA-Ingestion/0.1 (+https://aia.ntpu.ai/about)";

const STRAPI_FETCH: FetchPolicy = {
  methods: ["POST"],
  timeoutMs: 15_000,
  maxResponseBytes: 5 * 1024 * 1024,
  acceptedContentTypes: ["application/json"],
  userAgent: USER_AGENT,
  followRedirects: false,
  maxRedirects: 0,
  minIntervalMs: 0,
};

/** 學校自架的 HTML 網站：每個請求間隔 1 秒，避免造成對方負擔。 */
const HTML_FETCH: FetchPolicy = {
  methods: ["GET", "POST"],
  timeoutMs: 20_000,
  maxResponseBytes: 3 * 1024 * 1024,
  acceptedContentTypes: ["text/html"],
  userAgent: USER_AGENT,
  followRedirects: false,
  maxRedirects: 0,
  minIntervalMs: 1_000,
};

/**
 * 全部公告來源的個資過濾模式。使用者 2026-10-03 決定全部放行（官網本來就公開）。
 * 改成 "student-ids" 只擋含學號的名單（掃描約 13 則），"all" 連姓名名單也擋（約 77 則）。
 */
const PERSONAL_DATA_GUARD: PersonalDataGuard = "off";

const DAILY = { schedule: "daily", maxStalenessSeconds: 48 * 60 * 60 };

/** 處室代碼 → 中文名稱（MCP 工具說明與回應使用）。 */
export const UNIT_NAMES: Record<string, string> = {
  ord: "研究發展處",
  oga: "總務處",
  osa: "學生事務處",
  oaa: "教務處",
  oa: "主計室",
  cic: "資訊中心",
  oia: "國際事務處",
  eec: "進修暨推廣部",
  alumni: "校友服務中心",
  edusp: "高教深耕計畫辦公室",
  os: "秘書室",
  sustainable: "永續發展辦公室",
  ope: "體育室",
  cge: "通識教育中心",
  op: "人事室",
  library: "圖書館",
  lc: "語言中心",
  president: "校長室",
  "vice-president-academic": "學術副校長室",
  "vice-president-administration": "行政副校長室",
  "vice-president-financial": "財務暨永續發展副校長室",
};

/**
 * 在 new.ntpu.edu.tw 有公告的處室（2026-10-03 依官網前端設定與學校 API 實際筆數確認）。
 * siteKey 是學校 Strapi 的 sitesApproved 值。
 */
const STRAPI_ANNOUNCEMENT_UNITS: { unit: string; siteKey: string; newsUrlBase?: string }[] = [
  { unit: "ord", siteKey: "ord_ntpu" },
  { unit: "oga", siteKey: "oga_ntpu" },
  { unit: "osa", siteKey: "osa_ntpu" },
  { unit: "oaa", siteKey: "oaa_ntpu" },
  { unit: "oa", siteKey: "oa_ntpu" },
  { unit: "cic", siteKey: "cic_ntpu" },
  { unit: "oia", siteKey: "oia_ntpu" },
  { unit: "eec", siteKey: "eec_ntpu" },
  { unit: "alumni", siteKey: "alumni_ntpu" },
  { unit: "edusp", siteKey: "edusp_ntpu" },
  { unit: "os", siteKey: "os_ntpu" },
  // 永續辦公室的公告顯示在自己的網站（new.ntpu.edu.tw/sustainable/news 會顯示「找不到」），2026-10-03 確認。
  { unit: "sustainable", siteKey: "sustainable_ntpu", newsUrlBase: "https://esdg.ntpu.edu.tw/news" },
  { unit: "ope", siteKey: "ope_ntpu" },
  { unit: "cge", siteKey: "cge_ntpu" },
  { unit: "op", siteKey: "op_ntpu" },
];

/**
 * 只有固定介紹頁、沒有公告的單位（2026-10-03 確認公告數為 0）。
 * 頁面路徑即 new.ntpu.edu.tw 上的網址；已標 (deprecated) 的舊頁面不收錄。
 */
const PAGE_UNITS: { unit: string; pagePaths: string[] }[] = [
  { unit: "president", pagePaths: ["/president", "/educational-philosophy"] },
  { unit: "vice-president-academic", pagePaths: ["/vice-president-academic"] },
  { unit: "vice-president-administration", pagePaths: ["/vice-president-administration"] },
  { unit: "vice-president-financial", pagePaths: ["/vice-president-financial"] },
];

const strapiOrigin = {
  origin: "https://api-carrier.ntpu.edu.tw",
  allowedPathPrefixes: ["/strapi"],
  entrypoints: ["/strapi"],
};

/**
 * 所有允許抓取的來源都在這裡宣告（規格 06 §6）。新增來源前需確認資料擁有者、
 * 是否公開、是否需要登入；需要 gm 登入的頁面不得加入。
 */
export const SOURCES: readonly SourceDefinition[] = [
  ...STRAPI_ANNOUNCEMENT_UNITS.map(({ unit, siteKey, newsUrlBase }): SourceDefinition => {
    const base = newsUrlBase ?? `https://new.ntpu.edu.tw/${unit}/news`;
    return {
      id: `${unit}-announcements`,
      sourceUnit: unit,
      sourceType: "official_api",
      trustLevel: "official",
      homepageUrl: base,
      newsUrlBase: base,
      ...strapiOrigin,
      parser: "strapi-publications",
      adapter: { kind: "strapi-publications", siteKey, personalDataGuard: PERSONAL_DATA_GUARD },
      entityType: "announcement",
      enabled: true,
      fetch: STRAPI_FETCH,
      freshness: DAILY,
    };
  }),
  ...PAGE_UNITS.map(
    ({ unit, pagePaths }): SourceDefinition => ({
      id: `${unit}-pages`,
      sourceUnit: unit,
      sourceType: "official_api",
      trustLevel: "official",
      homepageUrl: `https://new.ntpu.edu.tw/${unit}`,
      newsUrlBase: `https://new.ntpu.edu.tw/${unit}`,
      ...strapiOrigin,
      parser: "strapi-sections",
      adapter: { kind: "strapi-sections", pagePaths },
      entityType: "page",
      enabled: true,
      fetch: STRAPI_FETCH,
      freshness: DAILY,
    }),
  ),
  {
    // 圖書館真正的官網（new.ntpu.edu.tw/library 幾乎是空頁）。最新消息約 51 則。
    id: "library-announcements",
    sourceUnit: "library",
    sourceType: "official_web",
    trustLevel: "official",
    homepageUrl: "https://library.ntpu.edu.tw/multiplehtml/3c152b26c59f4dba96939df64e2edd2f",
    newsUrlBase: "https://library.ntpu.edu.tw/singlehtml/3c152b26c59f4dba96939df64e2edd2f",
    origin: "https://library.ntpu.edu.tw",
    allowedPathPrefixes: [
      "/multiplehtml/3c152b26c59f4dba96939df64e2edd2f",
      "/singlehtml/3c152b26c59f4dba96939df64e2edd2f",
    ],
    entrypoints: [
      "/multiplehtml/3c152b26c59f4dba96939df64e2edd2f",
      "/singlehtml/3c152b26c59f4dba96939df64e2edd2f",
    ],
    queryRules: { "/singlehtml/3c152b26c59f4dba96939df64e2edd2f": { cntId: /^[0-9a-f]{32}$/ } },
    parser: "html-news",
    adapter: {
      kind: "html-news",
      site: "library-ewpt",
      maxDetailsPerRun: 60,
      reverifyAfterSeconds: 7 * 86_400,
      personalDataGuard: PERSONAL_DATA_GUARD,
    },
    entityType: "announcement",
    enabled: true,
    fetch: HTML_FETCH,
    freshness: DAILY,
  },
  {
    // 語言中心自己的網站。最新消息約 434 則（6 則一頁），內文分批抓。
    id: "lc-announcements",
    sourceUnit: "lc",
    sourceType: "official_web",
    trustLevel: "official",
    homepageUrl: "https://lc.ntpu.edu.tw/web/news/news.jsp",
    newsUrlBase: "https://lc.ntpu.edu.tw/web/news/news_in.jsp",
    origin: "https://lc.ntpu.edu.tw",
    allowedPathPrefixes: ["/web/news/news.jsp", "/web/news/news_in.jsp"],
    entrypoints: ["/web/news/news.jsp", "/web/news/news_in.jsp"],
    queryRules: {
      "/web/news/news.jsp": { npage: /^[1-9]\d{0,3}$/ },
      "/web/news/news_in.jsp": { np_no: /^NP\d{10,16}$/ },
    },
    parser: "html-news",
    adapter: {
      kind: "html-news",
      site: "lc-jsp",
      maxDetailsPerRun: 60,
      reverifyAfterSeconds: 7 * 86_400,
      personalDataGuard: PERSONAL_DATA_GUARD,
    },
    entityType: "announcement",
    enabled: true,
    fetch: HTML_FETCH,
    freshness: DAILY,
  },
];

export function getSource(id: string): SourceDefinition | undefined {
  return SOURCES.find((s) => s.id === id);
}

export function enabledSources(): SourceDefinition[] {
  return SOURCES.filter((s) => s.enabled);
}

/** 某類資料（公告或內容頁）有哪些處室。 */
export function sourceUnits(entityType?: SourceDefinition["entityType"]): string[] {
  return [...new Set(SOURCES.filter((s) => !entityType || s.entityType === entityType).map((s) => s.sourceUnit))].sort();
}

export function unitName(unit: string): string | undefined {
  return UNIT_NAMES[unit];
}

/** 啟動與測試時呼叫；任何一個來源設定不合規就直接失敗。 */
export function assertRegistryValid(sources: readonly SourceDefinition[] = SOURCES): void {
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`duplicate source id: ${source.id}`);
    ids.add(source.id);
    if (!UNIT_NAMES[source.sourceUnit]) throw new Error(`unit has no name: ${source.sourceUnit}`);
    validateSourceDefinition(source);
  }
}
