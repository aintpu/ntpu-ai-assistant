import { parse as parseHtml } from "node-html-parser";
import { IngestionError, safeMessage } from "../../shared/errors";
import { PageSchema } from "../../shared/schemas";
import { htmlToText } from "../html-text";
import type { SourceDefinition } from "../types";
import type { Adapter, AdapterRecord, RejectedRecord } from "./types";
import { decodeUtf8 } from "./types";

const SITE_ORIGIN = "https://new.ntpu.edu.tw";
const PAGE_PATH = /^\/[a-z0-9][a-z0-9/-]{0,100}$/;

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
  const candidate = {
    id: typeof row._id === "string" ? row._id.trim() : "",
    unit: source.sourceUnit,
    path,
    title: text(row.title),
    updatedAt: Number.isNaN(Date.parse(updatedRaw)) ? "" : new Date(updatedRaw).toISOString(),
    bodyText: htmlToText(html),
    links: linksOf(html),
    sourceUrl: PAGE_PATH.test(path) ? `${SITE_ORIGIN}${path}` : "",
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

/**
 * 校長室、副校長室等只有固定內容頁的單位：用頁面路徑精確查詢 strapi sections。
 * 路徑清單寫在來源設定裡，查詢語句固定，不接受外部輸入。
 */
export const strapiSectionsAdapter: Adapter = {
  start(source) {
    if (source.adapter.kind !== "strapi-sections") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    const paths = source.adapter.pagePaths;
    if (paths.length === 0 || paths.length > 50 || !paths.every((p) => PAGE_PATH.test(p))) {
      throw new IngestionError("URL_NOT_ALLOWED", `invalid page paths for ${source.id}`);
    }
    const query =
      `{ sections(where:{name_in:${JSON.stringify(paths)}}) ` + `{ _id name title content updatedAt } }`;
    return [
      {
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
      },
    ];
  },
};
