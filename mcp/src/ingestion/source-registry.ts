import { validateSourceDefinition } from "./url-policy";
import type { SourceDefinition } from "./types";

const STRAPI_FETCH = {
  method: "POST" as const,
  timeoutMs: 15_000,
  maxResponseBytes: 5 * 1024 * 1024,
  acceptedContentTypes: ["application/json"],
  userAgent: "NTPU-AIA-Ingestion/0.1 (+https://aia.ntpu.ai/about)",
  followRedirects: false,
  maxRedirects: 0,
};

/**
 * 在 new.ntpu.edu.tw 有公告的處室（2026-10-03 依官網前端設定與學校 API 實際筆數確認）。
 * site key 是學校 Strapi 的 sitesApproved 值。校長室、三位副校長室只有內容頁；
 * 圖書館與語言中心用自己的網站，這些都不是這種來源，沒有列入。
 */
export const ANNOUNCEMENT_UNITS: readonly {
  unit: string;
  name: string;
  siteKey: string;
  /** 公告不在 new.ntpu.edu.tw/{unit}/news 時，填實際公開頁面的前綴。 */
  newsUrlBase?: string;
}[] = [
  { unit: "ord", name: "研究發展處", siteKey: "ord_ntpu" },
  { unit: "oga", name: "總務處", siteKey: "oga_ntpu" },
  { unit: "osa", name: "學生事務處", siteKey: "osa_ntpu" },
  { unit: "oaa", name: "教務處", siteKey: "oaa_ntpu" },
  { unit: "oa", name: "主計室", siteKey: "oa_ntpu" },
  { unit: "cic", name: "資訊中心", siteKey: "cic_ntpu" },
  { unit: "oia", name: "國際事務處", siteKey: "oia_ntpu" },
  { unit: "eec", name: "進修暨推廣部", siteKey: "eec_ntpu" },
  { unit: "alumni", name: "校友服務中心", siteKey: "alumni_ntpu" },
  { unit: "edusp", name: "高教深耕計畫辦公室", siteKey: "edusp_ntpu" },
  { unit: "os", name: "秘書室", siteKey: "os_ntpu" },
  // 永續辦公室的公告顯示在自己的網站（new.ntpu.edu.tw/sustainable/news 會顯示「找不到」），2026-10-03 確認。
  {
    unit: "sustainable",
    name: "永續發展辦公室",
    siteKey: "sustainable_ntpu",
    newsUrlBase: "https://esdg.ntpu.edu.tw/news",
  },
  { unit: "ope", name: "體育室", siteKey: "ope_ntpu" },
  { unit: "cge", name: "通識教育中心", siteKey: "cge_ntpu" },
  { unit: "op", name: "人事室", siteKey: "op_ntpu" },
];

/**
 * 所有允許抓取的來源都在這裡宣告（規格 06 §6）。新增來源前需確認資料擁有者、
 * 是否公開、是否需要登入；需要 gm 登入的頁面不得加入。
 */
export const SOURCES: readonly SourceDefinition[] = ANNOUNCEMENT_UNITS.map(({ unit, siteKey, newsUrlBase }) => ({
  id: `${unit}-announcements`,
  sourceUnit: unit,
  sourceType: "official_api",
  trustLevel: "official",
  homepageUrl: newsUrlBase ?? `https://new.ntpu.edu.tw/${unit}/news`,
  newsUrlBase: newsUrlBase ?? `https://new.ntpu.edu.tw/${unit}/news`,
  origin: "https://api-carrier.ntpu.edu.tw",
  allowedPathPrefixes: ["/strapi"],
  entrypoints: ["/strapi"],
  parser: "strapi-publications",
  entityType: "announcement",
  enabled: true,
  strapiSiteKey: siteKey,
  fetch: STRAPI_FETCH,
  freshness: {
    // 每天一次。cron 每 10 分鐘觸發、每次只跑一個到期的來源（見 pickDueSource）。
    schedule: "daily",
    maxStalenessSeconds: 48 * 60 * 60,
  },
}));

export function unitName(unit: string): string | undefined {
  return ANNOUNCEMENT_UNITS.find((u) => u.unit === unit)?.name;
}

export function getSource(id: string): SourceDefinition | undefined {
  return SOURCES.find((s) => s.id === id);
}

export function enabledSources(): SourceDefinition[] {
  return SOURCES.filter((s) => s.enabled);
}

export function sourceUnits(): string[] {
  return [...new Set(SOURCES.map((s) => s.sourceUnit))].sort();
}

/** 啟動與測試時呼叫；任何一個來源設定不合規就直接失敗。 */
export function assertRegistryValid(sources: readonly SourceDefinition[] = SOURCES): void {
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`duplicate source id: ${source.id}`);
    ids.add(source.id);
    validateSourceDefinition(source);
  }
}
