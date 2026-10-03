import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { IngestionError } from "../../shared/errors";
import { htmlToText } from "../html-text";
import type { SourceRequest } from "../types";

/** 列表頁上的一則公告。 */
export interface ListItem {
  id: string;
  title: string;
  /** 台灣日期 YYYY-MM-DD。 */
  date: string;
}

export interface ListPage {
  items: ListItem[];
  /** 連到外部網站（不是本站內文頁）的列表項目數。 */
  external: number;
  /** 列表總頁數。 */
  totalPages: number;
}

export interface DetailPage {
  title: string;
  date: string;
  bodyHtml: string;
  attachments: { name: string; url: string }[];
}

/** 一個 HTML 公告網站的結構：列表與內文頁的網址、選擇器都固定寫在這裡。 */
export interface HtmlSite {
  origin: string;
  listPath: string;
  detailPath: string;
  listRequest(page: number): SourceRequest;
  detailRequest(id: string): SourceRequest;
  detailUrl(id: string): string;
  parseList(html: string): ListPage;
  parseDetail(html: string, id: string): DetailPage;
}

const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|rar|7z|csv|txt)$/i;

export function clean(value: string | undefined | null): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/** 2026/10/03、2026-10-03 → 2026-10-03；格式不符回傳空字串。 */
export function taiwanDate(raw: string): string {
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(raw);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
}

/** 台灣日期當天 00:00（UTC+8）→ ISO UTC。 */
export function taiwanDateToIso(date: string): string {
  const t = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

function dom(html: string): HTMLElement {
  return parseHtml(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false } });
}

function stripSession(href: string): string {
  return href.replace(/;jsessionid=[^?#]*/i, "");
}

/** 內文裡的檔案連結與附件區：只保留同站或 https 的檔案網址。 */
function collectFiles(
  anchors: HTMLElement[],
  base: string,
  nameOf: (a: HTMLElement) => string,
): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(stripSession(href.trim()), base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const name = clean(nameOf(a)) || url.pathname.split("/").pop() || url.toString();
    const key = `${url}\n${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name.slice(0, 500), url: url.toString() });
  }
  return out;
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined || value === "") {
    throw new IngestionError("PARSER_DRIFT", `page structure changed: ${what} not found`);
  }
  return value;
}

// ── 圖書館 library.ntpu.edu.tw（ewpt CMS，伺服器端產生 HTML）──────────────────────

const LIBRARY_SVC = "3c152b26c59f4dba96939df64e2edd2f";

export const librarySite: HtmlSite = {
  origin: "https://library.ntpu.edu.tw",
  listPath: `/multiplehtml/${LIBRARY_SVC}`,
  detailPath: `/singlehtml/${LIBRARY_SVC}`,

  listRequest(page) {
    // 列表翻頁用表單 POST；每頁固定 10 筆（pageSize 參數會被忽略）。
    const form = new URLSearchParams({
      page: String(page),
      isPage: "true",
      pageSize: "10",
      orderField: "ONLINETIME",
      orderType: "desc",
      svcId: LIBRARY_SVC,
      categoryCode: "",
    });
    return {
      target: `${this.listPath}#page=${page}`,
      path: this.listPath,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form.toString(),
    };
  },

  detailRequest(id) {
    return { target: `${this.detailPath}?cntId=${id}`, path: this.detailPath, method: "GET", query: { cntId: id } };
  },

  detailUrl(id) {
    return `${this.origin}${this.detailPath}?cntId=${id}`;
  },

  parseList(html) {
    const root = dom(html);
    const total = /總共\s*(\d+)\s*頁/.exec(root.text);
    const totalPages = Number(required(total?.[1], "total page count"));
    const table = required(root.querySelector("table.table-list"), "table.table-list");
    const items: ListItem[] = [];
    let external = 0;
    for (const row of table.querySelectorAll("tbody tr")) {
      const link = row.querySelector('td[data-title="標題："] a');
      if (!link) continue;
      const href = stripSession(link.getAttribute("href") ?? "");
      const id = new RegExp(`/singlehtml/${LIBRARY_SVC}\\?(?:[^#]*&)?cntId=([0-9a-f]{32})`).exec(href)?.[1];
      if (!id) {
        external++;
        continue;
      }
      items.push({
        id,
        title: clean(link.getAttribute("title") || link.text),
        date: taiwanDate(row.querySelector('td[data-title="發布日期："]')?.text ?? ""),
      });
    }
    return { items, external, totalPages };
  },

  parseDetail(html) {
    const root = dom(html);
    const title = clean(required(root.querySelector("h2.h2-page-title"), "h2.h2-page-title").text);
    const article = required(root.querySelector("article"), "article");
    const info = root.querySelectorAll("div.info span").map((s) => clean(s.text));
    const date = taiwanDate(info.find((t) => t.startsWith("發布日期")) ?? "");
    const attachmentAnchors = root.querySelectorAll('div.attachment a[href^="/download/"]');
    const bodyFiles = article.querySelectorAll("a[href]").filter((a) => FILE_EXT.test(a.getAttribute("href") ?? ""));
    const attachments = collectFiles([...attachmentAnchors, ...bodyFiles], `${this.origin}/`, (a) =>
      (a.getAttribute("title") ?? "").replace(/^下載[：:]\s*/, "") || a.text,
    );
    return { title, date, bodyHtml: article.innerHTML, attachments };
  },
};

// ── 語言中心 lc.ntpu.edu.tw（JSP，伺服器端產生 HTML）────────────────────────────────

export const lcSite: HtmlSite = {
  origin: "https://lc.ntpu.edu.tw",
  listPath: "/web/news/news.jsp",
  detailPath: "/web/news/news_in.jsp",

  listRequest(page) {
    return { target: `${this.listPath}?npage=${page}`, path: this.listPath, method: "GET", query: { npage: String(page) } };
  },

  detailRequest(id) {
    return { target: `${this.detailPath}?np_no=${id}`, path: this.detailPath, method: "GET", query: { np_no: id } };
  },

  detailUrl(id) {
    return `${this.origin}${this.detailPath}?np_no=${id}`;
  },

  parseList(html) {
    const root = dom(html);
    // 只有一頁時可能沒有分頁列。
    const pager = root.querySelector("div.number_pageArea")?.toString() ?? "";
    const pages = [...pager.matchAll(/goselectedpage\((\d+)\)/g)].map((m) => Number(m[1]));
    const totalPages = Math.max(1, ...pages);
    const items: ListItem[] = [];
    let external = 0;
    for (const item of required(root.querySelector("div.list_area"), "div.list_area").querySelectorAll("div.list")) {
      const href = item.querySelector("div.more_btn a")?.getAttribute("href") ?? "";
      const id = /news_in\.jsp\?(?:[^#]*&)?np_no=(NP\d{10,16})\b/.exec(href)?.[1];
      if (!id) {
        external++;
        continue;
      }
      items.push({
        id,
        title: clean(item.querySelector("div.info div.title")?.text),
        date: taiwanDate(item.querySelector("div.info div.date")?.text ?? ""),
      });
    }
    return { items, external, totalPages };
  },

  parseDetail(html) {
    const root = dom(html);
    const title = clean(required(root.querySelector("div.titStyle1 h2"), "div.titStyle1 h2").text);
    const date = taiwanDate(root.querySelector("div.in_titStyle span")?.text ?? "");
    const body = required(root.querySelector("section.textArea"), "section.textArea");
    const files = body.querySelectorAll("a[href]").filter((a) => FILE_EXT.test(a.getAttribute("href") ?? ""));
    const attachments = collectFiles(files, `${this.origin}${this.detailPath}`, (a) => a.text);
    return { title, date, bodyHtml: body.innerHTML, attachments };
  },
};

export const HTML_SITES = { "library-ewpt": librarySite, "lc-jsp": lcSite } as const;

export function bodyText(html: string): string {
  return htmlToText(html);
}
