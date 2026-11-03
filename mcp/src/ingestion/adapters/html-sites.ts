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

/** 圖書館 ewpt 的一個服務（svcId）：列表 multiplehtml/<svc>（表單 POST 翻頁）、內文 singlehtml/<svc>?cntId=。 */
export function librarySiteFor(svc: string): HtmlSite {
  return {
  origin: "https://library.ntpu.edu.tw",
  listPath: `/multiplehtml/${svc}`,
  detailPath: `/singlehtml/${svc}`,

  listRequest(page) {
    // 列表翻頁用表單 POST；每頁固定 10 筆（pageSize 參數會被忽略）。
    const form = new URLSearchParams({
      page: String(page),
      isPage: "true",
      pageSize: "10",
      orderField: "ONLINETIME",
      orderType: "desc",
      svcId: svc,
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
      const id = new RegExp(`/singlehtml/${svc}\\?(?:[^#]*&)?cntId=([0-9a-f]{8,32})`).exec(href)?.[1];
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
}

export const librarySite = librarySiteFor(LIBRARY_SVC);

/** 語言中心內容頁（lc.ntpu.edu.tw/web/…jsp）：標題 div.titStyle1 h2、內文是標題後面的 div.containerIn（div.content 是頁尾）。 */
export function parseLcPage(html: string): { title: string; bodyHtml: string } {
  const root = dom(html);
  const title = clean(required(root.querySelector("div.titStyle1 h2"), "div.titStyle1 h2").text);
  const body = required(root.querySelector("div.right div.containerIn") ?? root.querySelector("div.containerIn"), "div.containerIn");
  for (const el of body.querySelectorAll("script, style")) el.remove();
  return { title, bodyHtml: body.innerHTML };
}

/** 圖書館內容頁（singlehtml／只有一則內容的 multiplehtml）：標題 h2.h2-page-title、內文 article。 */
export function parseLibraryPage(html: string): { title: string; bodyHtml: string } {
  const root = dom(html);
  const title = clean(required(root.querySelector("h2.h2-page-title"), "h2.h2-page-title").text);
  const article = required(root.querySelector("article"), "article");
  return { title, bodyHtml: article.innerHTML };
}

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

// ── 財務金融英語碩士學位學程 GMBA www.gmba.ntpu.edu.tw（JSP，與語言中心同一家廠商、版型不同；2026-11-03 加入）──
// 列表 news.jsp?npage=（每頁 12 則）只顯示月、日；內文頁 news_in.jsp?np_id=NP + 建立時間（毫秒），日期取自編號。

/**
 * GMBA 內容頁與公告內文：標題 div.right_title h1、內文 div.text_area。
 * 師資、校友、檔案下載是清單頁，沒有 text_area：改用右側區塊（去掉標題）。
 */
export function parseGmbaPage(html: string): { title: string; bodyHtml: string } {
  const root = dom(html);
  const title = clean(required(root.querySelector("div.right_title h1"), "div.right_title h1").text);
  const area = root.querySelector("div.right div.text_area") ?? root.querySelector("div.text_area");
  const right = root.querySelector("div.right");
  const body = required(area ?? right, "div.text_area");
  if (!area) for (const el of body.querySelectorAll("div.right_title")) el.remove();
  for (const el of body.querySelectorAll("script, style")) el.remove();
  return { title, bodyHtml: body.innerHTML };
}

/** NP1791882343315 → 台灣日期（編號是建立時間的毫秒數）。 */
export function gmbaDate(id: string): string {
  const ms = Number(/^NP(\d{13})$/.exec(id)?.[1]);
  if (!ms) return "";
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

export const gmbaSite: HtmlSite = {
  origin: "https://www.gmba.ntpu.edu.tw",
  listPath: "/web/news/news.jsp",
  detailPath: "/web/news/news_in.jsp",

  listRequest(page) {
    return { target: `${this.listPath}?npage=${page}`, path: this.listPath, method: "GET", query: { npage: String(page) } };
  },

  detailRequest(id) {
    return { target: `${this.detailPath}?np_id=${id}`, path: this.detailPath, method: "GET", query: { np_id: id } };
  },

  detailUrl(id) {
    return `${this.origin}${this.detailPath}?np_id=${id}`;
  },

  parseList(html) {
    const pages = [...html.matchAll(/goselectedpage\((\d+)\)/g)].map((m) => Number(m[1]));
    const totalPages = Math.max(1, ...pages);
    const items: ListItem[] = [];
    let external = 0;
    const lists = dom(html).querySelectorAll("div.list div.list_in");
    required(lists.length ? lists : null, "div.list");
    // 第一頁上方三則是 div.title 裡的連結，下方列表是整塊包在連結裡；上方三則也會出現在下方列表
    const seen = new Set<string>();
    for (const item of lists) {
      const a = item.querySelector("a[href]");
      const id = /news_in\.jsp\?(?:[^#]*&)?np_id=(NP\d{13})\b/.exec(a?.getAttribute("href") ?? "")?.[1];
      if (!id) {
        external++;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, title: clean(item.querySelector("div.title")?.text), date: gmbaDate(id) });
    }
    return { items, external, totalPages };
  },

  parseDetail(html, id) {
    const { title, bodyHtml } = parseGmbaPage(html);
    const files = dom(bodyHtml).querySelectorAll("a[href]").filter((a) => FILE_EXT.test(a.getAttribute("href") ?? ""));
    const attachments = collectFiles(files, `${this.origin}${this.detailPath}`, (a) => a.text);
    return { title, date: gmbaDate(id), bodyHtml, attachments };
  },
};

/**
 * Google 協作平台（電子商務研究中心 ebrc.gm.ntpu.edu.tw）：標題是 div[role=main] 的 h1，
 * 內文是頁面上各個 section（第一個是標題、最後一個是頁尾的單位資訊）。
 */
export function parseGoogleSitesPage(html: string): { title: string; bodyHtml: string } {
  const root = dom(html);
  const main = required(root.querySelector('div[role="main"]'), "div[role=main]");
  const title = clean(main.querySelector("h1")?.text) || clean(root.querySelector("title")?.text.split(" - ").pop());
  const sections = required(root.querySelectorAll("section").length ? root.querySelectorAll("section") : null, "section");
  for (const sec of sections) for (const el of sec.querySelectorAll("script, style")) el.remove();
  return { title: required(title, "page title"), bodyHtml: sections.map((sec) => sec.innerHTML).join("\n") };
}

// ── 企業永續發展研究中心 ccs.ntpu.edu.tw（靜態 HTML＋前端讀 backend/data.json；2026-11-03 加入）──

/** 靜態頁：標題取 <title> 的「 - 」或「 | 」之前，內文是 body 去掉頁首、頁尾、選單與程式。 */
export function parseCcsPage(html: string): { title: string; bodyHtml: string } {
  const root = dom(html);
  const title = clean(required(root.querySelector("title"), "title").text.split(/ [-|] /)[0]);
  // 部分頁面的 <body> 前有未關閉的標籤，解析後沒有 body：改用整份 html（head 裡只有 title 與 meta）
  const body = required(root.querySelector("body") ?? root.querySelector("html"), "body");
  for (const el of body.querySelectorAll("head, script, style, noscript, header, footer, nav, #header, #footer")) el.remove();
  return { title: required(title, "title"), bodyHtml: body.innerHTML };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 純文字（\n 換行）→ 段落 HTML，交給 htmlToText 統一處理。 */
function textToHtml(text: string): string {
  return text
    .split(/\n/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

function ccsData(json: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new IngestionError("PARSER_DRIFT", "page structure changed: data.json is not JSON");
  }
  return required(data && typeof data === "object" ? (data as Record<string, unknown>) : null, "data.json object");
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** data.json 的 news：每則有 id、title、date（YYYY-MM-DD）、content（純文字）；內文頁 news-detail.html?id=。 */
export function parseCcsNews(json: string): InlineNews[] {
  const data = ccsData(json);
  const news = required(Array.isArray(data.news) ? (data.news as unknown[]) : null, "data.json news");
  const out: InlineNews[] = [];
  for (const raw of news) {
    const n = raw as Record<string, unknown>;
    const number = Number(n.id);
    const title = clean(str(n.title));
    if (!Number.isInteger(number) || number <= 0 || number >= 10_000_000 || !title) continue;
    const body = str(n.content) || str(n.excerpt);
    out.push({
      number,
      title,
      date: taiwanDate(str(n.date)),
      bodyHtml: textToHtml(body),
      url: `https://ccs.ntpu.edu.tw/pages/news/news-detail.html?id=${number}`,
    });
  }
  return out;
}

const CCS_TEAM_GROUPS: [string, string][] = [
  ["center_members", "中心成員"],
  ["advisors", "顧問"],
  ["full_time", "專任研究人員"],
  ["part_time", "兼任研究人員"],
];

/** 組織成員頁（organization.html）由前端讀 data.json 的 team 產生：依組別列出姓名、職稱、簡介與聯絡方式。 */
export function parseCcsTeam(json: string): { title: string; bodyHtml: string } {
  const team = required(ccsData(json).team as Record<string, unknown> | undefined, "data.json team");
  const parts: string[] = [];
  for (const [key, label] of CCS_TEAM_GROUPS) {
    const members = Array.isArray(team[key]) ? (team[key] as Record<string, unknown>[]) : [];
    if (members.length === 0) continue;
    parts.push(`<h2>${label}</h2>`);
    for (const m of members) {
      const fields = [
        str(m.name),
        str(m.position) && `職務：${str(m.position)}`,
        str(m.bio) && `簡介：${str(m.bio)}`,
        str(m.email) && `電子郵件：${str(m.email)}`,
        str(m.phone) && `電話：${str(m.phone)}`,
      ].filter(Boolean);
      if (fields.length) parts.push(`<p>${fields.map(escapeHtml).join("；")}</p>`);
    }
  }
  return { title: "組織成員", bodyHtml: required(parts.join(""), "team members") };
}

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
  /** 網站放在子目錄時的路徑前綴（金融科技中心是 /fintech）；listPath 要自行包含。 */
  basePath?: string;
}

/** 補齊歷史公告時列出的最大數量（避免流水號異常時產生過多項目）。 */
const COLLEGE_MAX_ITEMS = 20_000;

export function collegeId(spec: Pick<CollegeSiteSpec, "idPrefix">, n: number): string {
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
  const view = `${spec.basePath ?? ""}/view.php`;
  return {
    origin: spec.origin,
    listPath: spec.listPath,
    detailPath: view,

    listRequest() {
      const q = spec.listQuery;
      const target = q ? `${spec.listPath}?${new URLSearchParams(q)}` : spec.listPath;
      return { target, path: spec.listPath, method: "GET", ...(q ? { query: q } : {}) };
    },

    detailRequest(id) {
      const param = collegeParam(collegeNumber(spec, id));
      return { target: `${view}?${spec.idParam}=${param}`, path: view, method: "GET", query: { [spec.idParam]: param } };
    },

    detailUrl(id) {
      return `${spec.origin}${view}?${spec.idParam}=${collegeParam(collegeNumber(spec, id))}`;
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
      const attachments = collectFiles(files, `${spec.origin}${spec.basePath ?? ""}/`, (a) => a.text);
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
  // 2026-10-16 加入：休閒運動管理學系（最新消息同會計系，在列表頁）、國際企業研究所、數位行銷進修學士學位學程
  lsm: { origin: "https://lsm.ntpu.edu.tw", idParam: "id", idPrefix: "l", pagePrefix: "lsmp", listPath: "/news.php", firstNumber: 1 },
  giib: { origin: "https://giib.ntpu.edu.tw", idParam: "id", idPrefix: "g", pagePrefix: "giibp", listPath: "/index.php", firstNumber: 1 },
  dma: { origin: "https://www.dma.ntpu.edu.tw", idParam: "id", idPrefix: "m", pagePrefix: "dmap", listPath: "/index.php", firstNumber: 1 },
  // 2026-11-03 加入（使用者指定）：碩士在職專班 IEMBA、金融科技暨綠色金融研究中心（商學院網站的 /fintech/ 子目錄）
  iemba: { origin: "https://iemba.ntpu.edu.tw", idParam: "id", idPrefix: "i", pagePrefix: "iembap", listPath: "/index.php", firstNumber: 1 },
  fintech: { origin: "https://www.aacsb.ntpu.edu.tw", basePath: "/fintech", idParam: "id", idPrefix: "f", pagePrefix: "fintechp", listPath: "/fintech/index.php", firstNumber: 1 },
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

export function parseCollegeGroup(html: string, group: number, pagePrefix: string, basePath = ""): SitePage[] {
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
  // 沒有分頁按鈕的組（休閒運動管理學系每組只有一頁）：以左側選單目前所在的項目當標題
  const active = /class="active"[^>]*>\s*<a[^>]*>([^<]{1,40})</.exec(raw)?.[1];
  const fallbackTitle = active ? clean(active) : "";
  const pages: SitePage[] = [];
  // 按鈕被註解掉、也不是預設顯示的分頁看不到，不收（同 visibleHtml）
  const hidden = (pane: (typeof opens)[number]) => Boolean(pane.id) && !/\bactive\b/.test(pane.cls) && !labels.has(pane.id);
  const visibleCount = opens.filter((p) => !hidden(p)).length;
  opens.forEach((pane, index) => {
    if (hidden(pane)) return;
    const next = opens[index + 1]?.index ?? (footer > pane.end ? footer : raw.length);
    const label = labels.get(pane.id) || (visibleCount === 1 && fallbackTitle) || `第 ${index + 1} 頁`;
    pages.push({
      key: `${pagePrefix}${String(group).padStart(3, "0")}t${String(index + 1).padStart(2, "0")}`,
      title: label,
      path: `${basePath}/page.php?id=${group}&ids=${index + 1}`,
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
  /** 每則有自己的內文頁時（企業永續中心）；沒有則指向列表頁。 */
  url?: string;
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
  "giib-php": collegeSite(COLLEGE_SITES.giib),
  "dma-php": collegeSite(COLLEGE_SITES.dma),
  "iemba-php": collegeSite(COLLEGE_SITES.iemba),
  "fintech-php": collegeSite(COLLEGE_SITES.fintech),
  "gmba-jsp": gmbaSite,
  "mis-wp": misSite,
} as const;

export function bodyText(html: string): string {
  return htmlToText(html);
}
