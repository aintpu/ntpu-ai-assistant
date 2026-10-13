import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { IngestionError } from "../../shared/errors";
import { htmlToText, visibleHtml } from "../html-text";
import type { SourceRequest } from "../types";

/** 列表頁上的一則公告。 */
export interface ListItem {
  id: string;
  title: string;
  /** 台灣日期 YYYY-MM-DD。 */
  date: string;
  /** 內文頁路徑無法由編號推回時（資管所 WordPress 文章網址）由列表提供。 */
  path?: string;
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
  detailRequest(id: string, item?: ListItem): SourceRequest;
  detailUrl(id: string, item?: ListItem): string;
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

// ── 商學院 www.aacsb.ntpu.edu.tw（PHP，伺服器端產生 HTML；使用者 2026-10-13 指定）───────────────
// 最新消息列表沒有分頁、只列最新約 24 則；內文頁 view.php?id= 是流水號的 base64。
// 使用者選擇補齊歷史公告：列表以「1 到最新流水號」的每個編號當作項目，每次只抓有限數量的未收錄編號。
// 已刪除的編號回傳沒有標題與刊登時間的空白頁，記入隔離區後不再重抓。

/** 商學院公告編號：b + 7 位流水號（RecordIdSchema 至少 8 碼）。 */
export function aacsbId(n: number): string {
  return `b${String(n).padStart(7, "0")}`;
}

function aacsbNumber(id: string): number {
  const m = /^b(\d{7})$/.exec(id);
  if (!m) throw new IngestionError("INTERNAL_ERROR", `bad business news id: ${id}`);
  return Number(m[1]);
}

/** 流水號 ↔ view.php 的 id 參數（base64）。 */
export function aacsbParam(n: number): string {
  return btoa(String(n));
}

function aacsbDecode(param: string): number | null {
  try {
    const n = Number(atob(param));
    return Number.isInteger(n) && n > 0 && n < 10_000_000 ? n : null;
  } catch {
    return null;
  }
}

/** 補齊歷史公告時列出的最大數量（避免流水號異常時產生過多項目）。 */
const AACSB_MAX_ITEMS = 20_000;

export const aacsbSite: HtmlSite = {
  origin: "https://www.aacsb.ntpu.edu.tw",
  listPath: "/news.php",
  detailPath: "/view.php",

  listRequest() {
    return {
      target: `${this.listPath}?id=0&ids=17`,
      path: this.listPath,
      method: "GET",
      query: { id: "0", ids: "17" },
    };
  },

  detailRequest(id) {
    const param = aacsbParam(aacsbNumber(id));
    return { target: `${this.detailPath}?id=${param}`, path: this.detailPath, method: "GET", query: { id: param } };
  },

  detailUrl(id) {
    return `${this.origin}${this.detailPath}?id=${aacsbParam(aacsbNumber(id))}`;
  },

  parseList(html) {
    const numbers = [...html.matchAll(/view\.php\?id=([A-Za-z0-9+/]{2,12}={0,2})/g)]
      .map((m) => aacsbDecode(m[1]!))
      .filter((n): n is number => n !== null);
    const max = required(numbers.length ? Math.max(...numbers) : null, "news links");
    const items: ListItem[] = [];
    for (let n = max; n >= Math.max(1, max - AACSB_MAX_ITEMS + 1); n--) items.push({ id: aacsbId(n), title: "", date: "" });
    return { items, external: 0, totalPages: 1 };
  },

  parseDetail(html) {
    const root = dom(html);
    const main = required(root.querySelector("div.main"), "div.main");
    const title = clean(main.querySelector("div.post-content h3")?.text);
    const date = taiwanDate(/刊登時間：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(main.text)?.[1] ?? "");
    const posts = main.querySelector("div.blog-posts") ?? main;
    // 內文：去掉區塊標題（最新消息）、標題卡片與聯絡人／刊登時間等欄位
    for (const el of posts.querySelectorAll("article.post, h3")) el.remove();
    let bodyHtml = posts.innerHTML.replace(/<p>\s*(聯絡人|聯絡電話|刊登時間|分享連結)：[\s\S]*?<\/p>/g, "");
    if (!title) bodyHtml = "";
    const files = posts
      .querySelectorAll("a[href]")
      .filter((a) => FILE_EXT.test(a.getAttribute("href") ?? "") || (a.getAttribute("href") ?? "").includes("uploads/file/"));
    const attachments = collectFiles(files, `${this.origin}/`, (a) => a.text);
    return { title, date, bodyHtml, attachments };
  },
};

/**
 * 商學院內容頁：page.php?id=N 一次包含該組所有分頁（tab-pane），ids 只決定預設開哪一頁。
 * 每組抓一次（ids=1），再依分頁切成一筆一筆。按鈕被註解掉、也不是預設顯示的分頁不收（visibleHtml）。
 */
export interface SitePage {
  key: string;
  title: string;
  path: string;
  bodyHtml: string;
}

export function parseAacsbGroup(html: string, group: number): SitePage[] {
  const root = dom(visibleHtml(html));
  // 部分頁面 HTML 標籤沒有正確關閉（例如 USR 計畫頁），分頁不一定在 div.main 裡：直接在整頁找
  required(root.querySelector("div.main"), "div.main");
  const labels = new Map<string, string>();
  for (const a of root.querySelectorAll("a[href^='#']")) {
    const id = (a.getAttribute("href") ?? "").slice(1);
    const text = clean(a.text);
    if (id && text && !labels.has(id)) labels.set(id, text);
  }
  const pages: SitePage[] = [];
  root.querySelectorAll("div.tab-pane").forEach((pane, index) => {
    const label = labels.get(pane.getAttribute("id") ?? "") || `第 ${index + 1} 頁`;
    pages.push({
      key: `cobp${String(group).padStart(3, "0")}t${String(index + 1).padStart(2, "0")}`,
      title: label,
      path: `/page.php?id=${group}&ids=${index + 1}`,
      bodyHtml: pane.innerHTML,
    });
  });
  return pages;
}

// ── 資訊管理研究所 www.mis.ntpu.edu.tw（WordPress；使用者 2026-10-13 指定）─────────────────
// REST API 需要登入，改用公開的 wp-sitemap 當列表（列出全部文章，約 224 則）；
// 文章網址是 /YYYY/MM/DD/slug/，日期取自網址（內文頁沒有 article:published_time）。

/** 文章網址：sitemap 裡的原樣（slug 已百分比編碼）。 */
export const MIS_POST_PATH = /^\/(20\d{2})\/(\d{2})\/(\d{2})\/[A-Za-z0-9%_-]{1,400}\/$/;

/** FNV-1a 32 位元：把 slug 縮成固定長度的編號。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 資管所文章編號：mis + 刊登日期 + 網址雜湊（例如 mis20261006a1b2c3d4）。 */
export function misPostId(path: string): string {
  const m = MIS_POST_PATH.exec(path);
  if (!m) throw new IngestionError("INTERNAL_ERROR", `bad mis post path: ${path}`);
  return `mis${m[1]}${m[2]}${m[3]}${fnv1a(path.toLowerCase())}`;
}

function misPath(id: string, item?: ListItem): string {
  if (!item?.path || misPostId(item.path) !== id) throw new IngestionError("INTERNAL_ERROR", `mis post path unknown: ${id}`);
  return item.path;
}

export const misSite: HtmlSite = {
  origin: "https://www.mis.ntpu.edu.tw",
  listPath: "/wp-sitemap-posts-post-1.xml",
  detailPath: "/",

  listRequest() {
    return { target: this.listPath, path: this.listPath, method: "GET" };
  },

  detailRequest(id, item) {
    const path = misPath(id, item);
    return { target: path, path, method: "GET" };
  },

  detailUrl(id, item) {
    return `${this.origin}${misPath(id, item)}`;
  },

  parseList(xml) {
    const items: ListItem[] = [];
    let external = 0;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!);
    required(locs.length ? locs : null, "sitemap <loc>");
    for (const loc of locs) {
      let url: URL;
      try {
        url = new URL(loc);
      } catch {
        external++;
        continue;
      }
      const m = MIS_POST_PATH.exec(url.pathname);
      if (url.origin !== this.origin || url.search || !m) {
        external++;
        continue;
      }
      items.push({ id: misPostId(url.pathname), title: "", date: `${m[1]}-${m[2]}-${m[3]}`, path: url.pathname });
    }
    return { items, external, totalPages: 1 };
  },

  parseDetail(html) {
    const root = dom(html);
    const title = clean(required(root.querySelector("h1.entry-title"), "h1.entry-title").text);
    const body = required(root.querySelector("div.post-content"), "div.post-content");
    const files = body.querySelectorAll("a[href]").filter((a) => FILE_EXT.test(a.getAttribute("href") ?? ""));
    const attachments = collectFiles(files, `${this.origin}/`, (a) => a.text);
    return { title, date: "", bodyHtml: body.innerHTML, attachments };
  },
};

/** 資管所固定頁面（WordPress page）：內文在 div.entry-content。 */
export function parseMisPage(html: string): { title: string; bodyHtml: string } {
  const root = dom(html);
  const title = clean(required(root.querySelector("h1.entry-title"), "h1.entry-title").text);
  const body = required(root.querySelector("div.entry-content"), "div.entry-content");
  return { title, bodyHtml: body.innerHTML };
}

export const HTML_SITES = {
  "library-ewpt": librarySite,
  "lc-jsp": lcSite,
  "aacsb-php": aacsbSite,
  "mis-wp": misSite,
} as const;

export function bodyText(html: string): string {
  return htmlToText(html);
}
