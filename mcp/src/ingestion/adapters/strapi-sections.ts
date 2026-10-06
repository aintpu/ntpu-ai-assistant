import { parse as parseHtml } from "node-html-parser";
import { IngestionError, safeMessage } from "../../shared/errors";
import { PageSchema } from "../../shared/schemas";
import { htmlToText } from "../html-text";
import type { SourceDefinition } from "../types";
import type { Adapter, AdapterRecord, RejectedRecord, Step } from "./types";
import { decodeUtf8 } from "./types";

const SITE_ORIGIN = "https://new.ntpu.edu.tw";
/** 指定頁面的路徑（只允許英數）。 */
const PAGE_PATH = /^\/[a-z0-9][a-z0-9/-]{0,100}$/;
/** 整站抓取時頁面的路徑：可含中文與括號（招生頁），但不允許空白、引號、角括號與反斜線。 */
const ANY_PAGE_PATH = /^\/[^\s"'<>\\]{1,200}$/u;
/** 整站抓取的前綴，例如 /osa/。 */
const PATH_PREFIX = /^\/[a-z0-9][a-z0-9-]{0,40}\/$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** 少於這個字數的頁面多半是官網動態帶入內容的空殼（例如教務處「考試」頁只有 2 個字），不收錄。 */
export const MIN_PAGE_CHARS = 50;
/** 首頁輪播、頁尾與已停用的頁面。 */
const NON_CONTENT_PATH = /\/(home\d*|foot)$|\(deprecated\)/;

/** strapi sections 回傳的原始欄位（未驗證）。刻意不查 editors（含承辦人信箱）。 */
interface StrapiSection {
  _id?: unknown;
  name?: unknown;
  title?: unknown;
  content?: unknown;
  updatedAt?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
}

/** 內文裡的連結：只保留 http(s)，相對路徑以 new.ntpu.edu.tw 補成完整網址。 */
function linksOf(html: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const a of parseHtml(html).querySelectorAll("a[href]")) {
    let url: URL;
    try {
      url = new URL(a.getAttribute("href")!.trim(), `${SITE_ORIGIN}/`);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const href = url.toString();
    const name = text(a.text) || href;
    if (seen.has(`${href}\n${name}`)) continue;
    seen.add(`${href}\n${name}`);
    out.push({ name: name.slice(0, 500), url: href });
  }
  return out;
}

export function normalizePage(row: StrapiSection, source: SourceDefinition): AdapterRecord {
  const path = typeof row.name === "string" ? row.name.trim() : "";
  const html = typeof row.content === "string" ? row.content : "";
  const updatedRaw = typeof row.updatedAt === "string" ? row.updatedAt : "";
  let lastSegment = path.split("/").filter(Boolean).pop() ?? "";
  try {
    lastSegment = decodeURIComponent(lastSegment);
  } catch {
    // 不是合法的百分比編碼就照原樣
  }
  const candidate = {
    id: typeof row._id === "string" ? row._id.trim() : "",
    unit: source.sourceUnit,
    path,
    // 招生頁等沒有 title，以路徑最後一段（例如「碩士班一般入學」）當標題
    title: text(row.title) || text(lastSegment),
    updatedAt: Number.isNaN(Date.parse(updatedRaw)) ? "" : new Date(updatedRaw).toISOString(),
    bodyText: htmlToText(html),
    links: linksOf(html),
    sourceUrl: ANY_PAGE_PATH.test(path) ? new URL(path, SITE_ORIGIN).toString() : "",
  };
  const parsed = PageSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new IngestionError("VALIDATION_FAILED", `page ${candidate.id || "(no id)"} invalid: ${fields}`);
  }
  const p = parsed.data;
  return {
    id: p.id,
    payload: p,
    title: p.title,
    searchText: [p.title, p.bodyText].join("\n"),
    sourceUrl: p.sourceUrl,
    publishedAt: p.updatedAt,
  };
}

export function parseSections(bytes: Uint8Array): StrapiSection[] {
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(bytes));
  } catch (err) {
    throw new IngestionError("PARSE_FAILED", `response is not valid UTF-8 JSON: ${(err as Error).message}`);
  }
  const body = (json ?? {}) as { data?: { sections?: unknown }; errors?: unknown };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new IngestionError("PARSE_FAILED", `GraphQL returned ${body.errors.length} error(s)`);
  }
  if (!Array.isArray(body.data?.sections)) {
    throw new IngestionError("PARSER_DRIFT", "data.sections is missing or not an array");
  }
  return body.data.sections as StrapiSection[];
}

function pagesStep(source: SourceDefinition, paths: string[]): Step {
  const query = `{ sections(where:{name_in:${JSON.stringify(paths)}}) { _id name title content updatedAt } }`;
  return {
    request: {
      target: `${source.entrypoints[0]}#sections`,
      path: source.entrypoints[0]!,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ query }),
    },
    fatal: true,
    async handle(bytes, ctx) {
      const rows = parseSections(bytes);
      if (rows.length === 0 && (await ctx.activeCount()) > 0) {
        throw new IngestionError("PARSER_DRIFT", "source returned zero pages but canonical data exists");
      }
      const records: AdapterRecord[] = [];
      const rejected: RejectedRecord[] = [];
      rows.forEach((row, index) => {
        // 只收錄設定裡的頁面；name_in 是精確比對，這裡再確認一次。
        if (typeof row.name !== "string" || !paths.includes(row.name)) {
          rejected.push({ id: `row-${index}`, reason: "unexpected page path", countsTowardDrift: true });
          return;
        }
        try {
          records.push(normalizePage(row, source));
        } catch (err) {
          const id = typeof row._id === "string" ? row._id.slice(0, 100) : `row-${index}`;
          rejected.push({ id, reason: safeMessage(err), countsTowardDrift: true });
        }
      });
      return { parsed: rows.length, records, rejected, skipped: 0, listComplete: true };
    },
  };
}

function prefixStep(source: SourceDefinition, prefix: string, page: number): Step {
  const query = `{ sections(limit:${PAGE_SIZE}, start:${page * PAGE_SIZE}, sort:"_id", where:{name_contains:${JSON.stringify(prefix)}}) { _id name title content updatedAt } }`;
  return {
    request: {
      target: `${source.entrypoints[0]}#sections:${prefix}:${page}`,
      path: source.entrypoints[0]!,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ query }),
    },
    fatal: true,
    async handle(bytes, ctx) {
      const rows = parseSections(bytes);
      if (page === 0 && rows.length === 0 && (await ctx.activeCount()) > 0) {
        throw new IngestionError("PARSER_DRIFT", "source returned zero pages but canonical data exists");
      }
      const records: AdapterRecord[] = [];
      const rejected: RejectedRecord[] = [];
      let skipped = 0;
      rows.forEach((row, index) => {
        const name = typeof row.name === "string" ? row.name : "";
        // name_contains 是包含比對，只收前綴相符的頁面；空殼、輪播、頁尾與停用頁不算資料。
        if (!name.startsWith(prefix) || NON_CONTENT_PATH.test(name)) {
          skipped++;
          return;
        }
        if (htmlToText(typeof row.content === "string" ? row.content : "").length < MIN_PAGE_CHARS) {
          skipped++;
          return;
        }
        try {
          records.push(normalizePage(row, source));
        } catch (err) {
          const id = typeof row._id === "string" ? row._id.slice(0, 100) : `row-${index}`;
          rejected.push({ id, reason: safeMessage(err), countsTowardDrift: true });
        }
      });
      const full = rows.length >= PAGE_SIZE;
      return {
        parsed: rows.length,
        records,
        rejected,
        skipped,
        next: full && page + 1 < MAX_PAGES ? [prefixStep(source, prefix, page + 1)] : [],
        listComplete: !full,
      };
    },
  };
}

/**
 * 學校官網的內容頁（strapi sections）。查詢語句固定，不接受外部輸入：
 * - pagePaths：校長室、副校長室等只有固定內容頁的單位，用頁面路徑精確查詢。
 * - pathPrefix：抓整個處室站台（例如 /osa/）的所有有內容頁面，翻頁到底。
 */
export const strapiSectionsAdapter: Adapter = {
  start(source) {
    if (source.adapter.kind !== "strapi-sections") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    const { pagePaths, pathPrefix } = source.adapter;
    if (pathPrefix !== undefined) {
      if (pagePaths?.length || !PATH_PREFIX.test(pathPrefix)) {
        throw new IngestionError("URL_NOT_ALLOWED", `invalid page prefix for ${source.id}`);
      }
      return [prefixStep(source, pathPrefix, 0)];
    }
    const paths = pagePaths ?? [];
    if (paths.length === 0 || paths.length > 50 || !paths.every((p) => PAGE_PATH.test(p))) {
      throw new IngestionError("URL_NOT_ALLOWED", `invalid page paths for ${source.id}`);
    }
    return [pagesStep(source, paths)];
  },
};
