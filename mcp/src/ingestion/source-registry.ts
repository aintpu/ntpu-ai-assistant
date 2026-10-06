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

/** 人工整理檔：從 R2 manual/ 讀取，不連網站（見 manual-inbox.ts）。 */
const MANUAL_FETCH: FetchPolicy = {
  methods: ["GET"],
  timeoutMs: 15_000,
  maxResponseBytes: 5 * 1024 * 1024,
  acceptedContentTypes: ["text/markdown", "text/plain", "application/json"],
  userAgent: USER_AGENT,
  followRedirects: false,
  maxRedirects: 0,
  minIntervalMs: 0,
};

const REPO_TREE = "https://github.com/aintpu/ntpu-ai-assistant/tree/main/crawler_data";
const REPO_BLOB = "https://github.com/aintpu/ntpu-ai-assistant/blob/main/crawler_data";
/** upload-manual 由兩份法規彙整 xlsx 轉出的 JSON。 */
const REGULATION_CATALOG = "derived/regulation-catalog.json";

/** 有法規全文檔的處室：處室代碼、全文檔、彙整表上的處室名稱。 */
const REGULATION_FULL_TEXT: { unit: string; file: string; owners: string[] }[] = [
  { unit: "oaa", file: "crawler_data/oaa_regulations.md", owners: ["教務處"] },
  { unit: "osa", file: "crawler_data/osa_regulations.md", owners: ["學生事務處"] },
  { unit: "op", file: "crawler_data/hr_regulations.md", owners: ["人事室"] },
  { unit: "oga", file: "crawler_data/oga_regulations.md", owners: ["總務處"] },
  { unit: "cge", file: "crawler_data/ge_regulations_extra.md", owners: ["通識教育中心"] },
];

/** 各處室常見問答檔 → 處室代碼。 */
const FAQ_FILES: { file: string; unit: string }[] = [
  { file: "crawler_data/ord_faq.md", unit: "ord" },
  { file: "crawler_data/oa_faq.md", unit: "oa" },
  { file: "crawler_data/lib_faq.md", unit: "library" },
  { file: "crawler_data/cic_faq.md", unit: "cic" },
  { file: "crawler_data/oia_faq.md", unit: "oia" },
  { file: "crawler_data/eec_faq.md", unit: "eec" },
  { file: "crawler_data/alu_faq.md", unit: "alumni" },
  { file: "crawler_data/sus_faq.md", unit: "sustainable" },
  { file: "crawler_data/edusp_faq.md", unit: "edusp" },
  { file: "crawler_data/os_faq.md", unit: "os" },
  { file: "crawler_data/pres_faq.md", unit: "president" },
  { file: "crawler_data/vpa_faq.md", unit: "vice-president-academic" },
  { file: "crawler_data/vpad_faq.md", unit: "vice-president-administration" },
  { file: "crawler_data/vpf_faq.md", unit: "vice-president-financial" },
  { file: "crawler_data/hr_content.md", unit: "op" },
  { file: "crawler_data/oga_content.md", unit: "oga" },
];

/** 法規彙整表上沒有全文檔的單位對應的處室代碼（見 adapters/manual.ts 的 OWNER_UNITS）。 */
const CATALOG_UNITS = ["os", "ord", "oia", "library", "ope", "oa", "cic", "eec", "alumni", "edusp", "lc", "academic"];

function manualBase(id: string, unit: string, homepage: string) {
  return {
    id,
    sourceUnit: unit,
    sourceType: "manual_verified" as const,
    trustLevel: "verified" as const,
    homepageUrl: homepage,
    newsUrlBase: REPO_BLOB,
    origin: "https://github.com",
    allowedPathPrefixes: [] as string[],
    enabled: true,
    fetch: MANUAL_FETCH,
    freshness: DAILY,
  };
}

const MANUAL_SOURCES: SourceDefinition[] = [
  ...REGULATION_FULL_TEXT.map(
    ({ unit, file, owners }): SourceDefinition => ({
      ...manualBase(`${unit}-regulations`, unit, `${REPO_BLOB}/${file.split("/")[1]}`),
      entrypoints: [REGULATION_CATALOG, file],
      parser: "manual-regulations",
      adapter: { kind: "manual-regulations", fullTextFile: file, catalogFile: REGULATION_CATALOG, catalogOwners: owners },
      entityType: "regulation",
    }),
  ),
  {
    ...manualBase("regulation-catalog", "regulations", REPO_TREE),
    entrypoints: [REGULATION_CATALOG],
    parser: "manual-regulation-catalog",
    adapter: {
      kind: "manual-regulation-catalog",
      catalogFile: REGULATION_CATALOG,
      excludeOwners: REGULATION_FULL_TEXT.flatMap((r) => r.owners),
    },
    entityType: "regulation",
    recordUnits: CATALOG_UNITS,
  },
  {
    ...manualBase("office-faqs", "faq", REPO_TREE),
    entrypoints: FAQ_FILES.map((f) => f.file),
    parser: "manual-faq",
    adapter: { kind: "manual-faq", files: FAQ_FILES },
    entityType: "faq",
    recordUnits: [...new Set(FAQ_FILES.map((f) => f.unit))],
  },
];

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
  academic: "學術單位（學院、研究中心等）",
  regulations: "全校法規彙編",
  faq: "各處室常見問答",
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

/**
 * 處室官網（new.ntpu.edu.tw）整站的內容頁：組別介紹、業務說明、各專區等。
 * 2026-10-06 盤點學校 API：17 個前綴約 520 頁，其中約 430 頁有實質內容；少於 50 字的空殼頁不收錄。
 * /admission/ 是教務處的招生資訊頁，/oia2/ 是國際處的第二個站台。
 */
const SITE_PAGE_PREFIXES: { id: string; unit: string; prefix: string }[] = [
  { id: "oaa", unit: "oaa", prefix: "/oaa/" },
  { id: "admission", unit: "oaa", prefix: "/admission/" },
  { id: "osa", unit: "osa", prefix: "/osa/" },
  { id: "op", unit: "op", prefix: "/op/" },
  { id: "oga", unit: "oga", prefix: "/oga/" },
  { id: "ord", unit: "ord", prefix: "/ord/" },
  { id: "oa", unit: "oa", prefix: "/oa/" },
  { id: "cic", unit: "cic", prefix: "/cic/" },
  { id: "oia", unit: "oia", prefix: "/oia/" },
  { id: "oia2", unit: "oia", prefix: "/oia2/" },
  { id: "eec", unit: "eec", prefix: "/eec/" },
  { id: "alumni", unit: "alumni", prefix: "/alumni/" },
  { id: "edusp", unit: "edusp", prefix: "/edusp/" },
  { id: "os", unit: "os", prefix: "/os/" },
  { id: "sustainable", unit: "sustainable", prefix: "/sustainable/" },
  { id: "ope", unit: "ope", prefix: "/ope/" },
  { id: "cge", unit: "cge", prefix: "/cge/" },
  { id: "library", unit: "library", prefix: "/library/" },
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
const WEB_SOURCES: SourceDefinition[] = [
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
  ...SITE_PAGE_PREFIXES.map(
    ({ id, unit, prefix }): SourceDefinition => ({
      id: `${id}-site-pages`,
      sourceUnit: unit,
      sourceType: "official_api",
      trustLevel: "official",
      homepageUrl: `https://new.ntpu.edu.tw${prefix.replace(/\/$/, "")}`,
      newsUrlBase: `https://new.ntpu.edu.tw${prefix.replace(/\/$/, "")}`,
      ...strapiOrigin,
      parser: "strapi-sections",
      adapter: { kind: "strapi-sections", pathPrefix: prefix },
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

export const SOURCES: readonly SourceDefinition[] = [...WEB_SOURCES, ...MANUAL_SOURCES];

export function getSource(id: string): SourceDefinition | undefined {
  return SOURCES.find((s) => s.id === id);
}

export function enabledSources(): SourceDefinition[] {
  return SOURCES.filter((s) => s.enabled);
}

/** 某類資料有哪些處室；一個來源涵蓋多個處室時（recordUnits）列出那些處室。 */
export function sourceUnits(entityType?: SourceDefinition["entityType"]): string[] {
  return [
    ...new Set(
      SOURCES.filter((s) => !entityType || s.entityType === entityType).flatMap((s) => s.recordUnits ?? [s.sourceUnit]),
    ),
  ].sort();
}

/** 這個來源有沒有某處室的資料。 */
export function sourceCovers(source: SourceDefinition, unit: string): boolean {
  return (source.recordUnits ?? [source.sourceUnit]).includes(unit);
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
    for (const unit of [source.sourceUnit, ...(source.recordUnits ?? [])]) {
      if (!UNIT_NAMES[unit]) throw new Error(`unit has no name: ${unit}`);
    }
    validateSourceDefinition(source);
  }
}
