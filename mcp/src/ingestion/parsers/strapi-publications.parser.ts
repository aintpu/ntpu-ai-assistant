import { IngestionError } from "../../shared/errors";
import type { SourceDefinition, SourceRequest } from "../types";

/** strapi 回傳的公告原始欄位（尚未驗證，屬於不受信任的中間資料）。 */
export interface StrapiPublication {
  _id?: unknown;
  type?: unknown;
  title?: unknown;
  publishAt?: unknown;
  content?: unknown;
  files?: unknown;
}

const PAGE_SIZE = 100;
/** 單一來源最多翻幾頁，避免 API 異常時無限抓取（100 × 50 = 5000 筆）。 */
const MAX_PAGES = 50;
const SITE_KEY = /^[a-z0-9_]{2,40}$/;

/**
 * 研發處等新版網站的公告來源：api-carrier.ntpu.edu.tw/strapi（GraphQL）。
 * 查詢語句固定，只有站台代碼、分頁位置與目前時間三個參數，皆由程式產生。
 */
export const strapiPublicationsParser = {
  name: "strapi-publications",
  pageSize: PAGE_SIZE,
  maxPages: MAX_PAGES,

  buildRequest(source: SourceDefinition, page: number, nowIso: string): SourceRequest {
    const siteKey = source.adapter.kind === "strapi-publications" ? source.adapter.siteKey : "";
    if (!SITE_KEY.test(siteKey)) {
      throw new IngestionError("URL_NOT_ALLOWED", `invalid strapi site key for ${source.id}`);
    }
    if (!Number.isInteger(page) || page < 0 || page >= MAX_PAGES) {
      throw new IngestionError("URL_NOT_ALLOWED", `page out of range: ${page}`);
    }
    if (Number.isNaN(Date.parse(nowIso))) throw new IngestionError("INTERNAL_ERROR", "invalid clock value");
    const start = page * PAGE_SIZE;
    const now = new Date(nowIso).toISOString();
    const query =
      `{ publications(sort:"publishAt:desc", start:${start}, limit:${PAGE_SIZE}, ` +
      `where:{isEvent:false, sitesApproved_in:"${siteKey}", lang_ne:"english", ` +
      `publishAt_lte:"${now}", unPublishAt_gte:"${now}"}) ` +
      `{ _id type title publishAt content files { name url } } }`;
    return {
      target: `${source.entrypoints[0]}#page=${page}`,
      path: source.entrypoints[0]!,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ query }),
    };
  },

  /**
   * 不屬於公告的項目，回傳排除原因；這些項目不寫入正式資料，也不算驗證失敗。
   * banner 是首頁輪播圖：標題與內文為空，文字只在圖片說明，通常連到另一篇正式公告。
   */
  exclusionReason(row: StrapiPublication): string | null {
    return row.type === "banner" ? "type=banner（首頁輪播圖，不是公告）" : null;
  },

  parse(bytes: Uint8Array): StrapiPublication[] {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch (err) {
      throw new IngestionError("PARSE_FAILED", `response is not valid UTF-8 JSON: ${(err as Error).message}`);
    }
    if (json === null || typeof json !== "object") {
      throw new IngestionError("PARSE_FAILED", "response is not a JSON object");
    }
    const body = json as { data?: { publications?: unknown }; errors?: unknown };
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new IngestionError("PARSE_FAILED", `GraphQL returned ${body.errors.length} error(s)`);
    }
    const list = body.data?.publications;
    if (!Array.isArray(list)) {
      throw new IngestionError("PARSER_DRIFT", "data.publications is missing or not an array");
    }
    return list as StrapiPublication[];
  },
};
