import { parse as parseHtml } from "node-html-parser";
import { IngestionError, safeMessage } from "../../shared/errors";
import { PageSchema } from "../../shared/schemas";
import { htmlToText } from "../html-text";
import type { SourceDefinition } from "../types";
import { COLLEGE_SITES, type CollegeSiteKey, clean, librarySiteFor, misSite, parseCollegeGroup, parseLcPage, parseLibraryPage, parseMisPage } from "./html-sites";
import type { Adapter, AdapterRecord, RejectedRecord, Step, StepOutcome } from "./types";
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

function groupStep(source: SourceDefinition, site: CollegeSiteKey, group: number, last: boolean): Step {
  const spec = COLLEGE_SITES[site];
  const path = "/page.php";
  return {
    request: { target: `${path}?id=${group}&ids=1`, path, method: "GET", query: { id: String(group), ids: "1" } },
    fatal: false,
    async handle(bytes) {
      const pages = parseCollegeGroup(decodeUtf8(bytes), group, spec.pagePrefix);
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
          links: linksOf(p.bodyHtml, `${spec.origin}/`),
          sourceUrl: `${spec.origin}${p.path}`,
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

const LIBRARY_ORIGIN = "https://library.ntpu.edu.tw";
/** 列表型服務的名稱：內文標題前面加上分類（例如「常見問題：借閱」），避免只看標題不知道是哪一類。 */
export const LIBRARY_LIST_NAMES: Record<string, string> = {
  "70dcb2e4549c413eb3d533f3b1e54dbe": "開放時間",
  "84fe7b52141e4ba99b4a00f1ee32f17e": "常見問題",
  f6ee8a61ea1e46e9b6627172c180ed04: "相關法規",
  "0c2cd767e5b44818b07c633eb5ea40ba": "各式表單",
};
/** 圖書館列表最多翻幾頁（相關法規目前 3 頁）。 */
const LIBRARY_MAX_LIST_PAGES = 20;

function pageRecord(source: SourceDefinition, id: string, path: string, title: string, bodyHtml: string, base: string): StepOutcome {
  const body = htmlToText(bodyHtml);
  if (body.length < MIN_CHARS) return { parsed: 1, records: [], rejected: [], skipped: 1 };
  const parsed = PageSchema.safeParse({
    id,
    unit: source.sourceUnit,
    path,
    title,
    // 頁面上的「發布日期」是第一次上架日，不是修改時間：留空，不以抓取時間冒充（老師建議 四-2）
    updatedAt: "",
    bodyText: body,
    links: linksOf(bodyHtml, base),
    sourceUrl: `${LIBRARY_ORIGIN}${path}`,
  });
  if (!parsed.success) {
    return { parsed: 1, records: [], rejected: [{ id, reason: safeMessage(parsed.error).slice(0, 200), countsTowardDrift: true }], skipped: 0 };
  }
  const p = parsed.data;
  return {
    parsed: 1,
    records: [{ id: p.id, payload: p, title: p.title, searchText: [p.title, p.bodyText].join("\n"), sourceUrl: p.sourceUrl, publishedAt: null }],
    rejected: [],
    skipped: 0,
  };
}

/** 圖書館單一內容頁：編號 lib + svc。 */
function libraryPageStep(source: SourceDefinition, path: string, last: boolean): Step {
  const svc = path.split("/").pop()!;
  return {
    request: { target: path, path, method: "GET" },
    fatal: false,
    async handle(bytes) {
      const page = parseLibraryPage(decodeUtf8(bytes));
      return { ...pageRecord(source, `lib${svc}`, path, page.title, page.bodyHtml, `${LIBRARY_ORIGIN}${path}`), listComplete: last };
    },
  };
}

/** 圖書館列表型服務（常見問題、相關法規、各式表單、開放時間）：翻完列表，每則內文一筆，編號 libc + cntId。 */
function libraryListStep(source: SourceDefinition, svc: string, page: number, category: string): Step {
  const site = librarySiteFor(svc);
  return {
    request: site.listRequest(page),
    fatal: false,
    async handle(bytes) {
      const list = site.parseList(decodeUtf8(bytes));
      const outcome: StepOutcome = { parsed: list.items.length, records: [], rejected: [], skipped: list.external };
      outcome.next = list.items.map((item) => ({
        request: site.detailRequest(item.id),
        fatal: false,
        async handle(detailBytes: Uint8Array) {
          const detail = parseLibraryPage(decodeUtf8(detailBytes));
          const path = `/singlehtml/${svc}?cntId=${item.id}`;
          const title = detail.title && detail.title !== category ? `${category}：${detail.title}` : clean(item.title) || detail.title;
          return pageRecord(source, `libc${item.id}`, path, title, detail.bodyHtml, `${LIBRARY_ORIGIN}${path}`);
        },
      }));
      if (page < list.totalPages) {
        if (page + 1 > LIBRARY_MAX_LIST_PAGES) throw new IngestionError("PARSER_DRIFT", "library list has too many pages");
        outcome.next.push(libraryListStep(source, svc, page + 1, category));
      }
      return outcome;
    },
  };
}

const LC_ORIGIN = "https://lc.ntpu.edu.tw";

/** 語言中心內容頁：編號 lcp + 路徑與參數去掉符號後的雜湊。 */
function lcPageStep(source: SourceDefinition, page: { path: string; query?: Record<string, string> }, last: boolean): Step {
  const qs = page.query ? `?${new URLSearchParams(page.query)}` : "";
  const full = `${page.path}${qs}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < full.length; i++) h = Math.imul(h ^ full.charCodeAt(i), 0x01000193) >>> 0;
  const id = `lcp${page.path.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}${h.toString(16).padStart(8, "0")}`;
  return {
    request: { target: full, path: page.path, method: "GET", ...(page.query ? { query: page.query } : {}) },
    fatal: false,
    async handle(bytes) {
      const parsed = parseLcPage(decodeUtf8(bytes));
      const body = htmlToText(parsed.bodyHtml);
      if (body.length < MIN_CHARS) return { parsed: 1, records: [], rejected: [], skipped: 1, listComplete: last };
      const result = PageSchema.safeParse({
        id,
        unit: source.sourceUnit,
        path: full,
        title: parsed.title,
        // JSP 頁面沒有公開修改時間：留空，不以抓取時間冒充（老師建議 四-2）
        updatedAt: "",
        bodyText: body,
        links: linksOf(parsed.bodyHtml, `${LC_ORIGIN}${page.path}`),
        sourceUrl: `${LC_ORIGIN}${full}`,
      });
      if (!result.success) {
        return { parsed: 1, records: [], rejected: [{ id, reason: safeMessage(result.error).slice(0, 200), countsTowardDrift: true }], skipped: 0, listComplete: last };
      }
      const p = result.data;
      return {
        parsed: 1,
        records: [{ id: p.id, payload: p, title: p.title, searchText: [p.title, p.bodyText].join("\n"), sourceUrl: p.sourceUrl, publishedAt: null }],
        rejected: [],
        skipped: 0,
        listComplete: last,
      };
    },
  };
}

/**
 * 內容頁網站：商學院與所屬學系（page.php，每組抓一次、依分頁切成多筆）與
 * 資管所（www.mis.ntpu.edu.tw 的 WordPress 固定頁面，一頁一筆）。請求間隔依來源設定。
 */
export const htmlPagesAdapter: Adapter = {
  start(source) {
    const cfg = source.adapter;
    if (cfg.kind !== "html-pages") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    if (cfg.site === "lc") {
      if (cfg.pages.length === 0 || cfg.pages.length > 60 || !cfg.pages.every((p) => source.entrypoints.includes(p.path))) {
        throw new IngestionError("URL_NOT_ALLOWED", `invalid lc pages for ${source.id}`);
      }
      return cfg.pages.map((p, i) => lcPageStep(source, p, i === cfg.pages.length - 1));
    }
    if (cfg.site === "library") {
      const all = [...cfg.pages, ...cfg.lists.map((svc) => `/multiplehtml/${svc}`)];
      if (cfg.pages.length === 0 || all.length > 100 || !all.every((p) => source.entrypoints.includes(p))) {
        throw new IngestionError("URL_NOT_ALLOWED", `invalid library pages for ${source.id}`);
      }
      // 列表放前面（會再產生內文請求），單頁最後一筆標記列表走完
      return [
        ...cfg.lists.map((svc) => libraryListStep(source, svc, 1, LIBRARY_LIST_NAMES[svc] ?? "")),
        ...cfg.pages.map((p, i) => libraryPageStep(source, p, i === cfg.pages.length - 1)),
      ];
    }
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
    return groups.map((g, i) => groupStep(source, cfg.site, g, i === groups.length - 1));
  },
};
