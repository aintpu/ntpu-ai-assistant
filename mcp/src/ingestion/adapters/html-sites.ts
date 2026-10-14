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

// ── 商學院與所屬學系的網站（同一套 PHP 系統，伺服器端產生 HTML）────────────────────────────
// 商學院 www.aacsb.ntpu.edu.tw（使用者 2026-10-13 指定）；企管系、金融系、會計系、統計系（2026-10-14 指定）。
// 最新消息列表沒有分頁、只列最新約 20 則；內文頁 view.php?id=（企管系是 nid=）是流水號的 base64，
// 各網站流水號各自獨立。使用者選擇補齊歷史公告：列表以「起始號到最新流水號」的每個編號當作項目，
// 每次只抓有限數量的未收錄編號；已刪除的編號回傳沒有標題的空白頁，記入隔離區後不再重抓。

export interface CollegeSiteSpec {
  origin: string;
  /** 內文頁參數名稱：多數網站是 id，企管系是 nid。 */
  idParam: "id" | "nid";
  /** 公告編號前綴（一個英文字母）＋ 7 位流水號（RecordIdSchema 至少 8 碼）。 */
  idPrefix: string;
  /** 內容頁編號前綴（例如 cobp001t01）。 */
  pagePrefix: string;
  /** 列出最新公告連結的頁面（用來找最新流水號）。 */
  listPath: string;
  listQuery?: Record<string, string>;
  /** 最小流水號（企管系從 1000001 起編）。 */
  firstNumber: number;
}

/** 補齊歷史公告時列出的最大數量（避免流水號異常時產生過多項目）。 */
const COLLEGE_MAX_ITEMS = 20_000;

export function collegeId(spec: CollegeSiteSpec, n: number): string {
  return `${spec.idPrefix}${String(n).padStart(7, "0")}`;
}

function collegeNumber(spec: CollegeSiteSpec, id: string): number {
  const m = new RegExp(`^${spec.idPrefix}(\\d{7})$`).exec(id);
  if (!m) throw new IngestionError("INTERNAL_ERROR", `bad college news id: ${id}`);
  return Number(m[1]);
}

/** 流水號 ↔ view.php 的參數（base64）。 */
export function collegeParam(n: number): string {
  return btoa(String(n));
}

function collegeDecode(param: string): number | null {
  try {
    const n = Number(atob(decodeURIComponent(param)));
    return Number.isInteger(n) && n > 0 && n < 10_000_000 ? n : null;
  } catch {
    return null;
  }
}

/** 內文裡每次瀏覽都會變的計數（「預覽人數:129」）：不收，避免每次抓取都被當成內容變動。 */
const VIEW_COUNTER = /<center>\s*預覽人數[:：]\s*\d+\s*<\/center>|預覽人數[:：]\s*\d+/g;

export function collegeSite(spec: CollegeSiteSpec): HtmlSite {
  const linkRe = new RegExp(`view\\.php\\?${spec.idParam}=([A-Za-z0-9+/%]{2,20}(?:={0,2}|(?:%3D){0,2}))`, "g");
  return {
    origin: spec.origin,
    listPath: spec.listPath,
    detailPath: "/view.php",

    listRequest() {
      const q = spec.listQuery;
      const target = q ? `${spec.listPath}?${new URLSearchParams(q)}` : spec.listPath;
      return { target, path: spec.listPath, method: "GET", ...(q ? { query: q } : {}) };
    },

    detailRequest(id) {
      const param = collegeParam(collegeNumber(spec, id));
      return { target: `/view.php?${spec.idParam}=${param}`, path: "/view.php", method: "GET", query: { [spec.idParam]: param } };
    },

    detailUrl(id) {
      return `${spec.origin}/view.php?${spec.idParam}=${collegeParam(collegeNumber(spec, id))}`;
    },

    parseList(html) {
      const numbers = [...html.matchAll(linkRe)]
        .map((m) => collegeDecode(m[1]!))
        .filter((n): n is number => n !== null && n >= spec.firstNumber);
      const max = required(numbers.length ? Math.max(...numbers) : null, "news links");
      const items: ListItem[] = [];
      const min = Math.max(spec.firstNumber, max - COLLEGE_MAX_ITEMS + 1);
      for (let n = max; n >= min; n--) items.push({ id: collegeId(spec, n), title: "", date: "" });
      return { items, external: 0, totalPages: 1 };
    },

    parseDetail(html) {
      const root = dom(html.replace(VIEW_COUNTER, ""));
      const main = required(root.querySelector("div.main"), "div.main");
      const head = main.querySelector("div.post-content");
      const title = clean(head?.querySelector("h3")?.text);
      // 刊登時間寫在內文下方（商學院、統計系）或標題右側（金融系）
      const date = taiwanDate(
        /刊登時間：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(main.text)?.[1] ??
          /([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(head?.text ?? "")?.[1] ??
          "",
      );
      const posts = main.querySelector("div.blog-posts") ?? main;
      // 內文：去掉區塊標題（最新消息）、標題卡片與聯絡人／刊登時間等欄位
      for (const el of posts.querySelectorAll("article.post, h3")) el.remove();
      let bodyHtml = posts.innerHTML.replace(/<p>\s*(聯絡人|聯絡電話|刊登時間|分享連結)：[\s\S]*?<\/p>/g, "");
      if (!title) bodyHtml = "";
      const files = posts
        .querySelectorAll("a[href]")
        .filter((a) => FILE_EXT.test(a.getAttribute("href") ?? "") || (a.getAttribute("href") ?? "").includes("uploads/file/"));
      const attachments = collectFiles(files, `${spec.origin}/`, (a) => a.text);
      return { title, date, bodyHtml, attachments };
    },
  };
}

export const COLLEGE_SITES = {
  aacsb: { origin: "https://www.aacsb.ntpu.edu.tw", idParam: "id", idPrefix: "b", pagePrefix: "cobp", listPath: "/news.php", listQuery: { id: "0", ids: "17" }, firstNumber: 1 },
  dba: { origin: "https://www.dba.ntpu.edu.tw", idParam: "nid", idPrefix: "d", pagePrefix: "dbap", listPath: "/index.php", firstNumber: 1_000_001 },
  coop: { origin: "https://coop.ntpu.edu.tw", idParam: "id", idPrefix: "c", pagePrefix: "coopp", listPath: "/index.php", firstNumber: 1 },
  stat: { origin: "https://www.stat.ntpu.edu.tw", idParam: "id", idPrefix: "s", pagePrefix: "statp", listPath: "/index.php", firstNumber: 1 },
  // 會計系的最新消息沒有內文頁（見 parseAccNews），只有內容頁走這裡
  acc: { origin: "https://www.acc.ntpu.edu.tw", idParam: "id", idPrefix: "a", pagePrefix: "accp", listPath: "/news.php", firstNumber: 1 },
} as const satisfies Record<string, CollegeSiteSpec>;

export type CollegeSiteKey = keyof typeof COLLEGE_SITES;

/** 商學院公告編號：b + 7 位流水號。 */
export function aacsbId(n: number): string {
  return collegeId(COLLEGE_SITES.aacsb, n);
}
export const aacsbParam = collegeParam;
export const aacsbSite = collegeSite(COLLEGE_SITES.aacsb);

/**
 * 內容頁：page.php?id=N 一次包含該組所有分頁（tab-pane），ids 只決定預設開哪一頁。
 * 每組抓一次（ids=1），再依分頁切成一筆一筆。按鈕被註解掉、也不是預設顯示的分頁不收。
 */
export interface SitePage {
  key: string;
  title: string;
  path: string;
  bodyHtml: string;
}

export function parseCollegeGroup(html: string, group: number, pagePrefix: string): SitePage[] {
  // 各網站常有沒正確關閉的標籤（商學院 USR 計畫頁、統計系與會計系師資頁），用 DOM 解析分頁會被截斷或互相包住：
  // 改在原始 HTML 上，以每個 tab-pane 的開頭切段，到下一個 tab-pane 或頁尾為止。
  const raw = html.replace(VIEW_COUNTER, "").replace(/<!--[\s\S]*?-->/g, "");
  required(/<div[^>]*class="main"/.test(raw) ? true : null, "div.main");
  const labels = new Map<string, string>();
  for (const m of raw.matchAll(/<a[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const text = clean(htmlToText(m[2]!));
    if (text && !labels.has(m[1]!)) labels.set(m[1]!, text);
  }
  const opens = [...raw.matchAll(/<div\b[^>]*class="([^"]*\btab-pane\b[^"]*)"[^>]*>/g)].map((m) => ({
    index: m.index!,
    end: m.index! + m[0].length,
    cls: m[1]!,
    id: /\bid="([^"]+)"/.exec(m[0])?.[1] ?? "",
  }));
  const footer = raw.search(/<footer\b|id="footer"/);
  const pages: SitePage[] = [];
  opens.forEach((pane, index) => {
    // 按鈕被註解掉、也不是預設顯示的分頁看不到，不收（同 visibleHtml）
    if (pane.id && !/\bactive\b/.test(pane.cls) && !labels.has(pane.id)) return;
    const next = opens[index + 1]?.index ?? (footer > pane.end ? footer : raw.length);
    const label = labels.get(pane.id) || `第 ${index + 1} 頁`;
    pages.push({
      key: `${pagePrefix}${String(group).padStart(3, "0")}t${String(index + 1).padStart(2, "0")}`,
      title: label,
      path: `/page.php?id=${group}&ids=${index + 1}`,
      bodyHtml: raw.slice(pane.end, next),
    });
  });
  return pages;
}

export function parseAacsbGroup(html: string, group: number): SitePage[] {
  return parseCollegeGroup(html, group, COLLEGE_SITES.aacsb.pagePrefix);
}

/** 會計系最新消息的一則（列表頁上以彈出視窗顯示全文，沒有內文頁）。 */
export interface InlineNews {
  number: number;
  title: string;
  date: string;
  bodyHtml: string;
}

/**
 * 會計系 news.php（最新一頁）與 r_news.php（「more...」第二頁；再往後的分頁要靠瀏覽器 session，抓不到）。
 * 每則是 div.modal#ssdefaultModal{流水號}：標題 h4.modal-title，內文 div.modal-body，最後一段是「刊登時間：」。
 */
export function parseAccNews(html: string): InlineNews[] {
  const root = dom(html.replace(VIEW_COUNTER, ""));
  const out: InlineNews[] = [];
  const seen = new Set<number>();
  for (const modal of root.querySelectorAll("div.modal")) {
    const n = Number(/^ssdefaultModal(\d{1,7})$/.exec(modal.getAttribute("id") ?? "")?.[1]);
    if (!n || seen.has(n)) continue;
    const title = clean(modal.querySelector("h4.modal-title")?.text);
    const body = modal.querySelector("div.modal-body");
    if (!title || !body) continue;
    seen.add(n);
    const date = taiwanDate(/刊登時間：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(body.text)?.[1] ?? "");
    const bodyHtml = body.innerHTML.replace(/<p>\s*刊登時間：[\s\S]*?<\/p>/g, "");
    out.push({ number: n, title, date, bodyHtml });
  }
  return out;
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
  "dba-php": collegeSite(COLLEGE_SITES.dba),
  "coop-php": collegeSite(COLLEGE_SITES.coop),
  "stat-php": collegeSite(COLLEGE_SITES.stat),
  "mis-wp": misSite,
} as const;

export function bodyText(html: string): string {
  return htmlToText(html);
}
