import { IngestionError, safeMessage } from "../../shared/errors";
import { PageSchema } from "../../shared/schemas";
import type { SourceDefinition } from "../types";
import type { Adapter, AdapterRecord, RejectedRecord, Step, StepOutcome } from "./types";
import { decodeUtf8 } from "./types";

const SITE_ORIGIN = "https://new.ntpu.edu.tw";
const FILE_ORIGIN = "https://cms-carrier.ntpu.edu.tw";
const PAGE_SIZE = 100;
/** 最多翻幾頁（國際處目前約 1,744 筆 = 18 頁）。 */
const MAX_PAGES = 60;
/** 一個分類最多列幾個檔案（PageSchema links 上限 500）。 */
const MAX_FILES_PER_TAG = 500;
const SITE_KEY = /^[a-z][a-z0-9_]{1,40}$/;

/** strapi documents 回傳的原始欄位（未驗證）。刻意不查 uploadBy（上傳者帳號）。 */
interface StrapiDocument {
  _id?: unknown;
  name?: unknown;
  tags?: unknown;
  updatedAt?: unknown;
  file?: { url?: unknown; ext?: unknown } | null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
}

/** FNV-1a 32 位元：把「處室＋分類」縮成固定長度的編號。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function parseDocuments(bytes: Uint8Array): StrapiDocument[] {
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(bytes));
  } catch (err) {
    throw new IngestionError("PARSE_FAILED", `response is not valid UTF-8 JSON: ${(err as Error).message}`);
  }
  const body = (json ?? {}) as { data?: { documents?: unknown }; errors?: unknown };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new IngestionError("PARSE_FAILED", `GraphQL returned ${body.errors.length} error(s)`);
  }
  if (!Array.isArray(body.data?.documents)) throw new IngestionError("PARSER_DRIFT", "data.documents is missing or not an array");
  return body.data.documents as StrapiDocument[];
}

interface FileEntry {
  name: string;
  url: string;
  ext: string;
  date: string;
}

/**
 * 學校官網各處室的「檔案庫」（strapi documents：表單、法規、會議紀錄、統計等），使用者 2026-10-15 指定。
 * 依「處室＋分類標籤」整理成一頁一筆：內文列出檔名、格式、更新日期，links 是檔案下載網址；
 * 官方連結是官網的分類頁 /<處室>/files?tag=<分類>。一個檔案有多個標籤時，每個分類都列出。
 */
export const strapiDocumentsAdapter: Adapter = {
  start(source: SourceDefinition) {
    const cfg = source.adapter;
    if (cfg.kind !== "strapi-documents") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    if (!SITE_KEY.test(cfg.siteKey) || !/^[a-z][a-z0-9-]{1,30}$/.test(cfg.sitePath)) {
      throw new IngestionError("URL_NOT_ALLOWED", `invalid documents site for ${source.id}`);
    }
    const groups = new Map<string, FileEntry[]>();

    const pageStep = (page: number): Step => {
      const query = `{ documents(limit:${PAGE_SIZE}, start:${page * PAGE_SIZE}, sort:"_id", where:{site:${JSON.stringify(cfg.siteKey)}}) { _id name tags updatedAt file { url ext } } }`;
      return {
        request: {
          target: `${source.entrypoints[0]}#documents:${cfg.siteKey}:${page}`,
          path: source.entrypoints[0]!,
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify({ query }),
        },
        fatal: true,
        async handle(bytes, ctx): Promise<StepOutcome> {
          const rows = parseDocuments(bytes);
          if (page === 0 && rows.length === 0 && (await ctx.activeCount()) > 0) {
            throw new IngestionError("PARSER_DRIFT", "source returned zero documents but canonical data exists");
          }
          let skipped = 0;
          for (const row of rows) {
            const url = clean(row.file?.url);
            const name = clean(row.name);
            if (!name || !url.startsWith("/uploads/")) {
              skipped++;
              continue;
            }
            const updated = clean(row.updatedAt);
            const entry: FileEntry = {
              name: name.slice(0, 300),
              url: `${FILE_ORIGIN}${url}`,
              ext: clean(row.file?.ext).replace(/^\./, "").toLowerCase(),
              date: /^\d{4}-\d{2}-\d{2}/.exec(updated)?.[0] ?? "",
            };
            const tags = Array.isArray(row.tags) ? row.tags.map(clean).filter((t) => t && t.length <= 60) : [];
            for (const tag of tags.length ? tags : ["其他檔案"]) {
              const list = groups.get(tag) ?? [];
              list.push(entry);
              groups.set(tag, list);
            }
          }
          const outcome: StepOutcome = { parsed: rows.length, records: [], rejected: [], skipped };
          if (rows.length === PAGE_SIZE) {
            if (page + 1 >= MAX_PAGES) throw new IngestionError("PARSER_DRIFT", "documents list has too many pages");
            outcome.next = [pageStep(page + 1)];
            return outcome;
          }
          // 最後一頁：依分類產生頁面
          const records: AdapterRecord[] = [];
          const rejected: RejectedRecord[] = [];
          for (const [tag, files] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            files.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
            const shown = files.slice(0, MAX_FILES_PER_TAG);
            const id = `doc${cfg.siteKey.replace(/[^a-z0-9]/g, "")}${fnv1a(tag)}`.slice(0, 64);
            // 分類名稱太長時網址超過 PageSchema 的 200 字限制：改連處室檔案庫首頁
            const tagged = `/${cfg.sitePath}/files?tag=${encodeURIComponent(tag)}`;
            const path = tagged.length <= 200 ? tagged : `/${cfg.sitePath}/files`;
            const parsed = PageSchema.safeParse({
              id,
              unit: source.sourceUnit,
              path,
              title: `檔案庫：${tag}`,
              updatedAt: "",
              bodyText: [
                `檔案庫「${tag}」共 ${files.length} 個檔案${files.length > shown.length ? `（列出最新 ${shown.length} 個）` : ""}：`,
                ...shown.map((f) => `- ${f.name}（${f.ext || "檔案"}${f.date ? `，更新 ${f.date}` : ""}）`),
              ].join("\n"),
              links: shown.map((f) => ({ name: f.name, url: f.url })),
              sourceUrl: `${SITE_ORIGIN}${path}`,
            });
            if (!parsed.success) {
              rejected.push({ id, reason: safeMessage(parsed.error).slice(0, 200), countsTowardDrift: true });
              continue;
            }
            const p = parsed.data;
            records.push({ id: p.id, payload: p, title: p.title, searchText: [p.title, p.bodyText].join("\n"), sourceUrl: p.sourceUrl, publishedAt: null });
          }
          outcome.records = records;
          outcome.rejected = rejected;
          outcome.listComplete = true;
          return outcome;
        },
      };
    };
    return [pageStep(0)];
  },
};
