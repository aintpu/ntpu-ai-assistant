import { validateSourceDefinition } from "./url-policy";
import { ATTACHMENT_HOST, ATTACHMENT_PATH } from "./adapters/attachments";
import { MIS_POST_PATH } from "./adapters/html-sites";
import { OFFICIALS } from "./officials";
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

/** 資管所 WordPress：文章列表是 sitemap（application/xml），其餘同 HTML_FETCH。 */
const MIS_FETCH: FetchPolicy = { ...HTML_FETCH, methods: ["GET"], acceptedContentTypes: ["text/html", "application/xml"] };

/** 資管所固定頁面（wp-sitemap-posts-page-1.xml；不含首頁、最新消息等列表頁）。 */
const MIS_PAGES = [
  "/about-mis/", "/description/", "/history/", "/professor/", "/faculty/", "/admissions/", "/studyrules/",
  "/rules/", "/courses/", "/research/", "/students/", "/intern/", "/social/", "/community/", "/chdonation/",
  "/donatemethod/", "/partnership/", "/activity/", "/historyen/", "/donation/", "/donation-methods/",
  "/business-partners/", "/event-achievements/",
];

/**
 * 圖書館網站的內容頁（library.ntpu.edu.tw；使用者 2026-10-15 指定，取代移除的爬蟲轉 FAQ）。
 * 單頁取自首頁選單：借閱規則、開放時間、空間與設備、各身分借閱權限、館際合作、樓層介紹、館長與組織等；
 * 列表型（開放時間、常見問題、相關法規、各式表單）翻完列表再逐則抓內文。外部系統連結（/link/…）不收。
 */
const LIBRARY_SINGLE_PAGES = [
  "fd4e9f3429db4a6fb8f9a4cb26b9274d",
  "8aec38592a47423ea889ce358762f865",
  "b2c46be603ab41b4b8babca5d69aadc6",
  "21ac84fc9b4945f68998bb5ef9d0b2d4",
  "0c3ddeae137844d991eac647a6f4d121",
  "1630129901ef4b528576d3a136582a02",
  "b41b53dd60cf4441a069529b5466153e",
  "b3836bdaec03425f8ffd3c0ad8c24fda",
  "736fa3f35c1a4a8caccc539671c94589",
  "33342a58069c4f7fa32b14bc079b1bfc",
  "6d4a9613568a4fa9a4fa899fe0b1ab83",
  "0fcd1317260c42c0b5b3fd6397989c79",
  "dd17c43b653d4bbba02281909af63859",
  "78b2aac67f8d4c54a071f3f0475836b9",
  "b0bf8499909944c9b3f1abf08e739be4",
  "d6282ed90f0d46a799f835ce3600d5f0",
  "ddf9ffd4966b469ea23423c1b8cfd51c",
  "207ce8e9f11b4d09ba3f24b37ce21788",
  "bedda86f07984933b439f5b73d03a835",
  "85c4fa2101074cd1bb86e59e027f18b1",
  "51d3090bd89f476ca6e65e7c76138a1b",
  "b16ace5700364ee1a0791cdb5bf4b54e",
  "61edb5a72a304083bdcdd8305ee935fa",
  "419d08293ec446e8ae86e36b191d50fb",
  "ace45961de134aa5ae9e918d5cd3db04",
  "4ed5aadc5c8c4bc9ab74d3fd057e9c3c",
  "e2c1316e9c444511b2e6bbccfdd28b58",
  "9be8736d17114c5581ed9b02068da4e4",
  "1058880890f4405bbffecc43e6ff1981",
  "7c2208bfec60423c8c4f711d079adff1",
  "3acd478db09443fb8a0f414a358c7299",
  "08f7f2d93ec841508bc48988ba0b2787",
  "7f5072653a8c4692bb4795b47a8f9797",
  "0e0fbe73cbba4ef58cd875d76343a2dd",
  "0b999a83942b4b92862a1e2c9dd6e741",
  "a27eceb4199c483c9306c72b54a24996",
  "9584bc98a1e94e3ab9d99bb3b966ace9",
  "1d2af99e5f6043cb9c923788b0171a71",
  "d6cef9871e634fd69100335537129963",
  "cd4e061fe91243a89c9fa1bf9002fa10",
].map((svc) => `/singlehtml/${svc}`);
const LIBRARY_MULTI_PAGES = [
  "361d98eec29048a8baa2df27b7673c4b",
  "37ecc48011a94b21a77bfd394a48df26",
  "7cd1ff4702524c089cdae86d4e767f37",
  "016ee800075c424e8030f707b3a9a981",
  "5adf649a597c4f46bc5b6bb444ff683f",
  "6241fbf8c6614ce6b1ee22f8c2b67c76",
  "04623f72c6b54ffba47859b03239aeef",
  "725d0cf3b3ca46efa0741e0ad85590ce",
  "0d95ef9f9be545359d5fee4250f3fe56",
  "bcb2d0066d554e258d9ccfa488b17d5d",
  "f617e82f7e754a74a92d248579b1b698",
  "ebc38a81fcf849a884c27bcaf319e005",
].map((svc) => `/multiplehtml/${svc}`);
const LIBRARY_LISTS = [
  "70dcb2e4549c413eb3d533f3b1e54dbe",
  "84fe7b52141e4ba99b4a00f1ee32f17e",
  "f6ee8a61ea1e46e9b6627172c180ed04",
  "0c2cd767e5b44818b07c633eb5ea40ba",
];
const LIBRARY_PAGES = [...LIBRARY_SINGLE_PAGES, ...LIBRARY_MULTI_PAGES];
const LIBRARY_ENTRYPOINTS = [...LIBRARY_PAGES, ...LIBRARY_LISTS.flatMap((svc) => [`/multiplehtml/${svc}`, `/singlehtml/${svc}`])];

/**
 * 全部公告來源的個資過濾模式。使用者 2026-10-03 決定全部放行（官網本來就公開）。
 * 改成 "student-ids" 只擋含學號的名單（掃描約 13 則），"all" 連姓名名單也擋（約 77 則）。
 */
const PERSONAL_DATA_GUARD: PersonalDataGuard = "off";

/**
 * 商學院所屬學系的網站（與商學院同一套 PHP 系統；使用者 2026-10-14 指定加入，比照商學院補齊歷史公告）。
 * 內容頁組別取自各網站首頁選單；沒有分頁的空殼組別、以及金融系與統計系的 page.php?id=1（其實是最新消息列表，
 * 金融系的含內嵌圖片達 15MB）不收。會計系的最新消息沒有內文頁，另由 inline-news 只收列表上看得到的公告。
 */
const COLLEGE_DEPTS: {
  unit: string;
  origin: string;
  news: { site: "dba-php" | "coop-php" | "stat-php"; idParam: "id" | "nid" } | "inline";
  pages: "dba" | "coop" | "acc" | "stat";
  groups: number[];
}[] = [
  { unit: "dba", origin: "https://www.dba.ntpu.edu.tw", news: { site: "dba-php", idParam: "nid" }, pages: "dba", groups: [1, 2, 3, 4, 6, 100, 236, 252, 281, 288] },
  { unit: "coop", origin: "https://coop.ntpu.edu.tw", news: { site: "coop-php", idParam: "id" }, pages: "coop", groups: [4, 5, 6, 97, 150, 158] },
  { unit: "acc", origin: "https://www.acc.ntpu.edu.tw", news: "inline", pages: "acc", groups: [1, 2, 3, 4, 6, 7, 9, 10, 136, 170] },
  { unit: "stat", origin: "https://www.stat.ntpu.edu.tw", news: { site: "stat-php", idParam: "id" }, pages: "stat", groups: [4, 5, 6, 9, 97, 98, 141, 147, 150, 158, 162, 188, 194] },
];

const ACC_NEWS_PAGES = [
  { path: "/news.php", query: { id: "0", ids: "69" } },
  ...["69", "70", "71", "72"].map((tarea) => ({ path: "/r_news.php", query: { tarea } })),
];

function collegeDeptSources(d: (typeof COLLEGE_DEPTS)[number]): SourceDefinition[] {
  const common = { sourceUnit: d.unit, sourceType: "official_web" as const, trustLevel: "official" as const, origin: d.origin, enabled: true, fetch: HTML_FETCH, freshness: DAILY };
  const news: SourceDefinition =
    d.news === "inline"
      ? {
          ...common,
          id: `${d.unit}-announcements`,
          homepageUrl: `${d.origin}/news.php?id=0&ids=69`,
          newsUrlBase: `${d.origin}/news.php`,
          allowedPathPrefixes: ["/news.php", "/r_news.php"],
          entrypoints: ["/news.php", "/r_news.php"],
          queryRules: { "/news.php": { id: /^0$/, ids: /^69$/ }, "/r_news.php": { tarea: /^(69|70|71|72)$/ } },
          parser: "inline-news",
          adapter: { kind: "inline-news", site: "acc", pages: ACC_NEWS_PAGES },
          entityType: "announcement",
        }
      : {
          ...common,
          id: `${d.unit}-announcements`,
          homepageUrl: `${d.origin}/`,
          newsUrlBase: `${d.origin}/view.php`,
          allowedPathPrefixes: ["/index.php", "/view.php"],
          entrypoints: ["/index.php", "/view.php"],
          queryRules: { "/view.php": { [d.news.idParam]: /^[A-Za-z0-9+/]{2,16}={0,2}$/ } },
          parser: "html-news",
          adapter: {
            kind: "html-news",
            site: d.news.site,
            maxDetailsPerRun: 60,
            reverifyAfterSeconds: 30 * 86_400,
            personalDataGuard: PERSONAL_DATA_GUARD,
          },
          entityType: "announcement",
        };
  const pages: SourceDefinition = {
    ...common,
    id: `${d.unit}-site-pages`,
    homepageUrl: `${d.origin}/`,
    newsUrlBase: `${d.origin}/page.php`,
    allowedPathPrefixes: ["/page.php"],
    entrypoints: ["/page.php"],
    queryRules: { "/page.php": { id: /^\d{1,3}$/, ids: /^1$/ } },
    parser: "html-pages",
    adapter: { kind: "html-pages", site: d.pages, groups: d.groups },
    entityType: "page",
  };
  return [news, pages];
}


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

/**
 * 各處室常見問答檔 → 處室代碼。
 * 2026-10-15 使用者要求移除網路爬蟲轉成的 FAQ（13 個單位整份、研發處 175 題），只留研發處提供的 19 題與總務處、人事室的整理檔；
 * 移除的紀錄依一般規則標記為已移除，D1 的版本紀錄保留。
 */
const FAQ_FILES: { file: string; unit: string }[] = [
  { file: "crawler_data/ord_faq.md", unit: "ord" },
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
  attachments: "公告附件（各處室）",
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
  officials: "現任主管（各單位主管介紹頁）",
  business: "商學院",
  mis: "資訊管理研究所",
  dba: "企業管理學系",
  coop: "金融與合作經營學系",
  acc: "會計學系",
  stat: "統計學系",
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

/** 公告附件檔案（cms-carrier.ntpu.edu.tw/uploads/）：每個請求間隔 0.5 秒，單檔上限 15 MB。 */
const ATTACHMENT_FETCH: FetchPolicy = {
  methods: ["GET"],
  timeoutMs: 30_000,
  maxResponseBytes: 15 * 1024 * 1024,
  acceptedContentTypes: [
    "application/pdf",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    // 部分檔案伺服器以通用二進位類型回應；實際格式依副檔名判斷、解析失敗只留檔名與連結
    "application/octet-stream",
    "binary/octet-stream",
  ],
  userAgent: USER_AGENT,
  followRedirects: false,
  maxRedirects: 0,
  minIntervalMs: 500,
};

/**
 * 學校官網各處室的檔案庫（表單、法規、會議紀錄、統計等；strapi documents）。
 * 使用者 2026-10-15 指定這些處室（取代移除的爬蟲轉 FAQ 裡出自「表單下載」「法規」等頁面的內容）。
 */
const DOCUMENT_SITES: { unit: string; site: string }[] = [
  { unit: "ord", site: "ord" }, { unit: "osa", site: "osa" }, { unit: "oaa", site: "oaa" }, { unit: "oga", site: "oga" },
  { unit: "oa", site: "oa" }, { unit: "cic", site: "cic" }, { unit: "oia", site: "oia" }, { unit: "eec", site: "eec" },
  { unit: "alumni", site: "alumni" }, { unit: "edusp", site: "edusp" }, { unit: "os", site: "os" }, { unit: "op", site: "op" },
  // 2026-10-15 補上體育室、通識教育中心
  { unit: "ope", site: "ope" }, { unit: "cge", site: "cge" },
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
  ...DOCUMENT_SITES.map(
    ({ unit, site }): SourceDefinition => ({
      id: `${unit}-documents`,
      sourceUnit: unit,
      sourceType: "official_api",
      trustLevel: "official",
      homepageUrl: `https://new.ntpu.edu.tw/${site}`,
      newsUrlBase: `https://new.ntpu.edu.tw/${site}`,
      ...strapiOrigin,
      parser: "strapi-documents",
      adapter: { kind: "strapi-documents", siteKey: `${site}_ntpu`, sitePath: site },
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
    // 現任主管（老師建議 二-1）：姓名、職務、任期與官方英文姓名來自人工核對的對照表，
    // 每次執行都重新抓主管介紹頁確認姓名仍在頁面上；不在了就不再提供，需要人工重新核對。
    id: "current-officials",
    sourceUnit: "officials",
    sourceType: "official_api",
    trustLevel: "official",
    homepageUrl: "https://new.ntpu.edu.tw",
    newsUrlBase: "https://new.ntpu.edu.tw",
    ...strapiOrigin,
    parser: "strapi-officials",
    adapter: { kind: "strapi-officials" },
    entityType: "official",
    recordUnits: [...new Set(OFFICIALS.map((o) => o.unit))],
    enabled: true,
    fetch: STRAPI_FETCH,
    freshness: DAILY,
  },
  {
    // 公告附件的內容（PDF、ODF、DOCX 抽文字；圖片以 Workers AI 看圖模型辨識）。
    // 附件清單來自已收錄的公告，每次處理一小批；含個人資料的附件只記入隔離區，內容不公開。
    id: "announcement-attachments",
    sourceUnit: "attachments",
    sourceType: "official_document",
    trustLevel: "official",
    homepageUrl: "https://new.ntpu.edu.tw",
    newsUrlBase: "https://cms-carrier.ntpu.edu.tw/uploads",
    origin: `https://${ATTACHMENT_HOST}`,
    allowedPathPrefixes: ["/uploads"],
    entrypoints: ["/uploads"],
    pathRules: [ATTACHMENT_PATH],
    parser: "attachments",
    adapter: {
      kind: "attachments",
      maxPerRun: 40,
      maxOcrPerRun: 15,
      maxScannedPerRun: 3,
      maxOcrPagesPerPdf: 10,
      ocrModel: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    },
    entityType: "attachment",
    recordUnits: [...STRAPI_ANNOUNCEMENT_UNITS.map((u) => u.unit), "library", "lc"],
    enabled: true,
    fetch: ATTACHMENT_FETCH,
    freshness: DAILY,
  },
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
    // 商學院自己的網站（www.aacsb.ntpu.edu.tw；new.ntpu.edu.tw/business 幾乎沒有內容、也沒有公告）。
    // 使用者 2026-10-13 指定加入，並選擇補齊歷史公告：每次最多抓 60 則未收錄的編號（約 2,300 則，約一天補齊）。
    id: "business-announcements",
    sourceUnit: "business",
    sourceType: "official_web",
    trustLevel: "official",
    homepageUrl: "https://www.aacsb.ntpu.edu.tw/news.php?id=0&ids=17",
    newsUrlBase: "https://www.aacsb.ntpu.edu.tw/view.php",
    origin: "https://www.aacsb.ntpu.edu.tw",
    allowedPathPrefixes: ["/news.php", "/view.php"],
    entrypoints: ["/news.php", "/view.php"],
    queryRules: {
      "/news.php": { id: /^0$/, ids: /^17$/ },
      "/view.php": { id: /^[A-Za-z0-9+/]{2,12}={0,2}$/ },
    },
    parser: "html-news",
    adapter: {
      kind: "html-news",
      site: "aacsb-php",
      maxDetailsPerRun: 60,
      // 已收錄的公告很少修改；30 天才重新驗證一次，避免每週重抓兩千多則
      reverifyAfterSeconds: 30 * 86_400,
      personalDataGuard: PERSONAL_DATA_GUARD,
    },
    entityType: "announcement",
    enabled: true,
    fetch: HTML_FETCH,
    freshness: DAILY,
  },
  {
    // 商學院網站的內容頁（關於本院、單位介紹、師資、學生專區、研究、國際、企業關係、榮耀、捐款、USR）。
    id: "business-site-pages",
    sourceUnit: "business",
    sourceType: "official_web",
    trustLevel: "official",
    homepageUrl: "https://www.aacsb.ntpu.edu.tw/",
    newsUrlBase: "https://www.aacsb.ntpu.edu.tw/page.php",
    origin: "https://www.aacsb.ntpu.edu.tw",
    allowedPathPrefixes: ["/page.php"],
    entrypoints: ["/page.php"],
    queryRules: { "/page.php": { id: /^\d{1,3}$/, ids: /^1$/ } },
    parser: "html-pages",
    adapter: { kind: "html-pages", site: "aacsb", groups: [1, 2, 3, 4, 5, 6, 7, 9, 10, 132] },
    entityType: "page",
    enabled: true,
    fetch: HTML_FETCH,
    freshness: DAILY,
  },
  ...COLLEGE_DEPTS.flatMap(collegeDeptSources),
  {
    // 圖書館網站的內容頁（借閱規則、開放時間、空間設備、館際合作等）
    id: "library-web-pages",
    sourceUnit: "library",
    sourceType: "official_web",
    trustLevel: "official",
    homepageUrl: "https://library.ntpu.edu.tw/",
    newsUrlBase: "https://library.ntpu.edu.tw",
    origin: "https://library.ntpu.edu.tw",
    allowedPathPrefixes: LIBRARY_ENTRYPOINTS,
    entrypoints: LIBRARY_ENTRYPOINTS,
    queryRules: Object.fromEntries(LIBRARY_LISTS.map((svc) => [`/singlehtml/${svc}`, { cntId: /^[0-9a-f]{8,32}$/ }])),
    parser: "html-pages",
    adapter: { kind: "html-pages", site: "library", pages: LIBRARY_PAGES, lists: LIBRARY_LISTS },
    entityType: "page",
    enabled: true,
    fetch: HTML_FETCH,
    freshness: DAILY,
  },
  {
    // 資訊管理研究所網站（www.mis.ntpu.edu.tw，WordPress；使用者 2026-10-13 指定加入）。
    // 文章列表用 wp-sitemap（REST API 需要登入）；約 224 則，每次最多抓 60 則內文。
    id: "mis-announcements",
    sourceUnit: "mis",
    sourceType: "official_web",
    trustLevel: "official",
    homepageUrl: "https://www.mis.ntpu.edu.tw/latestnews/",
    newsUrlBase: "https://www.mis.ntpu.edu.tw",
    origin: "https://www.mis.ntpu.edu.tw",
    // 文章路徑 /20YY/…，再由 pathRules 限定完整格式
    allowedPathPrefixes: ["/wp-sitemap-posts-post-1.xml", ...Array.from({ length: 100 }, (_, i) => `/20${String(i).padStart(2, "0")}/`)],
    entrypoints: ["/wp-sitemap-posts-post-1.xml"],
    pathRules: [MIS_POST_PATH],
    parser: "html-news",
    adapter: {
      kind: "html-news",
      site: "mis-wp",
      maxDetailsPerRun: 60,
      reverifyAfterSeconds: 30 * 86_400,
      personalDataGuard: PERSONAL_DATA_GUARD,
    },
    entityType: "announcement",
    enabled: true,
    fetch: MIS_FETCH,
    freshness: DAILY,
  },
  {
    // 資管所網站的固定頁面（簡介、沿革、師資、招生、修業規定、課程、捐款、產學合作等）。
    id: "mis-site-pages",
    sourceUnit: "mis",
    sourceType: "official_web",
    trustLevel: "official",
    homepageUrl: "https://www.mis.ntpu.edu.tw/",
    newsUrlBase: "https://www.mis.ntpu.edu.tw",
    origin: "https://www.mis.ntpu.edu.tw",
    allowedPathPrefixes: MIS_PAGES,
    entrypoints: MIS_PAGES,
    parser: "html-pages",
    adapter: { kind: "html-pages", site: "mis", paths: MIS_PAGES },
    entityType: "page",
    enabled: true,
    fetch: MIS_FETCH,
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
