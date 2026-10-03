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
 * 所有允許抓取的來源都在這裡宣告（規格 06 §6）。新增來源前需確認資料擁有者、
 * 是否公開、是否需要登入；需要 gm 登入的頁面不得加入。
 */
export const SOURCES: readonly SourceDefinition[] = [
  {
    id: "ord-announcements",
    sourceUnit: "ord",
    sourceType: "official_api",
    trustLevel: "official",
    homepageUrl: "https://new.ntpu.edu.tw/ord/news",
    origin: "https://api-carrier.ntpu.edu.tw",
    allowedPathPrefixes: ["/strapi"],
    entrypoints: ["/strapi"],
    parser: "strapi-publications",
    entityType: "announcement",
    enabled: true,
    strapiSiteKey: "ord_ntpu",
    fetch: STRAPI_FETCH,
    freshness: {
      // 每天 UTC 18:00（台灣時間 02:00）。
      schedule: "0 18 * * *",
      maxStalenessSeconds: 48 * 60 * 60,
    },
  },
];

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
