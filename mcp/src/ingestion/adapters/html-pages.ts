import { parse as parseHtml } from "node-html-parser";
import { IngestionError, safeMessage } from "../../shared/errors";
import { PageSchema } from "../../shared/schemas";
import { htmlToText } from "../html-text";
import type { SourceDefinition } from "../types";
import { aacsbSite, clean, misSite, parseAacsbGroup, parseMisPage } from "./html-sites";
import type { Adapter, AdapterRecord, RejectedRecord, Step } from "./types";
import { decodeUtf8 } from "./types";

/** 少於這個字數的分頁多半是空殼或只有圖片，不收錄。 */
const MIN_CHARS = 50;

function linksOf(html: string, base: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const a of parseHtml(html).querySelectorAll("a[href]")) {
    let url: URL;
    try {
      url = new URL(a.getAttribute("href")!.trim(), base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const name = clean(a.text) || url.toString();
    const key = `${url}\n${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name.slice(0, 500), url: url.toString() });
  }
  return out.slice(0, 500);
}

function groupStep(source: SourceDefinition, group: number, last: boolean): Step {
  const path = "/page.php";
  return {
    request: { target: `${path}?id=${group}&ids=1`, path, method: "GET", query: { id: String(group), ids: "1" } },
    fatal: false,
    async handle(bytes) {
      const pages = parseAacsbGroup(decodeUtf8(bytes), group);
      if (pages.length === 0) throw new IngestionError("PARSER_DRIFT", `page group ${group} has no tabs`);
      const records: AdapterRecord[] = [];
      const rejected: RejectedRecord[] = [];
      let skipped = 0;
      for (const p of pages) {
        const body = htmlToText(p.bodyHtml);
        if (body.length < MIN_CHARS) {
          skipped++;
          continue;
        }
        const candidate = {
          id: p.key,
          unit: source.sourceUnit,
          path: p.path,
          title: p.title,
          // 網站沒有提供修改時間：留空，不以抓取時間冒充來源修訂時間（老師建議 四-2）
          updatedAt: "",
          bodyText: body,
          links: linksOf(p.bodyHtml, `${aacsbSite.origin}/`),
          sourceUrl: `${aacsbSite.origin}${p.path}`,
        };
        const parsed = PageSchema.safeParse(candidate);
        if (!parsed.success) {
          rejected.push({ id: p.key, reason: safeMessage(parsed.error).slice(0, 200), countsTowardDrift: true });
          continue;
        }
        const page = parsed.data;
        records.push({
          id: page.id,
          payload: page,
          title: page.title,
          searchText: [page.title, page.bodyText].join("\n"),
          sourceUrl: page.sourceUrl,
          publishedAt: null,
        });
      }
      return { parsed: pages.length, records, rejected, skipped, listComplete: last };
    },
  };
}

/** 資管所固定頁面的編號：misp + 路徑去掉符號（/admissions/ → mispadmissions）。 */
export function misPageKey(path: string): string {
  const slug = path.replace(/[^A-Za-z0-9]/g, "");
  return `misp${slug.padEnd(4, "0")}`.slice(0, 64);
}

function misStep(source: SourceDefinition, path: string, last: boolean): Step {
  return {
    request: { target: path, path, method: "GET" },
    fatal: false,
    async handle(bytes) {
      const page = parseMisPage(decodeUtf8(bytes));
      const body = htmlToText(page.bodyHtml);
      const key = misPageKey(path);
      if (body.length < MIN_CHARS) return { parsed: 1, records: [], rejected: [], skipped: 1, listComplete: last };
      const candidate = {
        id: key,
        unit: source.sourceUnit,
        path,
        title: page.title,
        // WordPress 頁面沒有公開修改時間：留空，不以抓取時間冒充來源修訂時間（老師建議 四-2）
        updatedAt: "",
        bodyText: body,
        links: linksOf(page.bodyHtml, `${misSite.origin}${path}`),
        sourceUrl: `${misSite.origin}${path}`,
      };
      const parsed = PageSchema.safeParse(candidate);
      if (!parsed.success) {
        const rejected: RejectedRecord[] = [{ id: key, reason: safeMessage(parsed.error).slice(0, 200), countsTowardDrift: true }];
        return { parsed: 1, records: [], rejected, skipped: 0, listComplete: last };
      }
      const p = parsed.data;
      const record: AdapterRecord = {
        id: p.id,
        payload: p,
        title: p.title,
        searchText: [p.title, p.bodyText].join("\n"),
        sourceUrl: p.sourceUrl,
        publishedAt: null,
      };
      return { parsed: 1, records: [record], rejected: [], skipped: 0, listComplete: last };
    },
  };
}

/**
 * 內容頁網站：商學院（www.aacsb.ntpu.edu.tw/page.php，每組抓一次、依分頁切成多筆）與
 * 資管所（www.mis.ntpu.edu.tw 的 WordPress 固定頁面，一頁一筆）。請求間隔依來源設定。
 */
export const htmlPagesAdapter: Adapter = {
  start(source) {
    const cfg = source.adapter;
    if (cfg.kind !== "html-pages") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    if (cfg.site === "mis") {
      const paths = cfg.paths;
      if (paths.length === 0 || paths.length > 60 || !paths.every((p) => source.entrypoints.includes(p))) {
        throw new IngestionError("URL_NOT_ALLOWED", `invalid page paths for ${source.id}`);
      }
      return paths.map((p, i) => misStep(source, p, i === paths.length - 1));
    }
    const groups = cfg.groups;
    if (groups.length === 0 || groups.length > 30 || !groups.every((g) => Number.isInteger(g) && g > 0 && g < 1000)) {
      throw new IngestionError("URL_NOT_ALLOWED", `invalid page groups for ${source.id}`);
    }
    return groups.map((g, i) => groupStep(source, g, i === groups.length - 1));
  },
};
