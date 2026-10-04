/**
 * 人工整理檔（crawler_data/）的解析。只做結構拆分，不改寫、不推論內容。
 * 格式依 repo 現有檔案：
 * - 法規全文：`## 法規名稱`，其後可能有「來源網址：」「標籤：」「上傳日期：」，內文以 `### Page N` 或 `### 全文` 分段。
 * - 常見問答：`### 問題`，其後是回答，再接「FAQ 編號：」「來源網址：」等欄位。
 */

export interface RegulationDoc {
  title: string;
  /** 同一檔案裡第幾次出現這個標題（從 0 起算），用來替重複標題產生穩定編號。 */
  occurrence: number;
  bodyText: string;
  fileUrl: string | null;
  tags: string[];
  uploadDate: string | null;
}

export interface FaqEntry {
  question: string;
  answer: string;
  /** 原檔的欄位，例如 { "FAQ 編號": "ORD-HQ-001", "來源網址": "https://…" }。 */
  fields: Record<string, string>;
  /** 欄位區原文（不含問題與回答），保留承辦組別、聯絡窗口等給使用者參考。 */
  details: string;
}

/** 法規彙整表的一列（upload-manual 由 xlsx 轉出，欄位名稱統一）。 */
export interface CatalogRow {
  /** 所屬單位／處室的原文名稱。 */
  owner: string;
  title: string;
  tags: string[];
  fileUrl: string | null;
  fileType: string | null;
  updatedDate: string | null;
  sourcePage: string | null;
  notes: string | null;
  /** academic（學術單位彙整表）或 admin（行政單位彙整表）。 */
  catalog: "academic" | "admin";
  /** 原始 xlsx 在 repo 的路徑。 */
  sourceFile: string;
}

export interface CatalogFile {
  rows: CatalogRow[];
}

/** 與 AIA 現行做法相同：去掉副檔名與所有空白後比對標題。 */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFC")
    .trim()
    .replace(/\.(pdf|docx?|odt|ods)$/i, "")
    .replace(/\s+/g, "");
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'，、；）)]+/;

function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 整格就是一個網址的欄位（彙整表的連結、法規的「來源網址：」）：整格解析，不用正規表示式截取。
 * 學校檔名常有括號與空白，例如「申請表(1141022修正).docx」；截取會把 .docx 與 .pdf 兩個檔案
 * 截成同一個、而且打不開的網址。空白由 URL 解析自動編碼為 %20。
 */
export function singleUrl(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (/^https?:\/\//i.test(v)) {
    const whole = httpUrl(v);
    if (whole) return whole;
  }
  return firstUrl(v);
}

/** 文字裡的第一個 http(s) 網址（欄位可能列了多個網址或夾雜說明時用）；其他一律視為沒有連結。 */
export function firstUrl(value: string | null | undefined): string | null {
  const m = (value ?? "").match(URL_IN_TEXT);
  if (!m) return null;
  try {
    const url = new URL(m[0]);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function splitTags(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(/[,，、]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

const REG_META = /^(來源網址|標籤|上傳日期)：\s*(.*)$/;
const PAGE_HEADING = /^###\s+(Page\s+\d+|全文)\s*$/i;

/** 依 `## ` 拆成一份份法規；內文去掉分頁標題與分隔線，其餘照原文。 */
export function parseRegulationsMarkdown(markdown: string): RegulationDoc[] {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/^## (?!#)/m).slice(1);
  const seen = new Map<string, number>();
  const docs: RegulationDoc[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const title = lines.shift()!.trim();
    if (!title) continue;
    const meta: Record<string, string> = {};
    const body: string[] = [];
    let inHeader = true;
    for (const line of lines) {
      const m = inHeader ? line.match(REG_META) : null;
      if (m) {
        meta[m[1]!] = m[2]!.trim();
        continue;
      }
      if (inHeader && line.trim() === "") continue;
      inHeader = false;
      if (PAGE_HEADING.test(line) || /^-{3,}\s*$/.test(line)) {
        body.push("");
        continue;
      }
      body.push(line.replace(/\s+$/, ""));
    }
    const key = normalizeTitle(title);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    docs.push({
      title,
      occurrence,
      bodyText: body.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
      fileUrl: singleUrl(meta["來源網址"]),
      tags: splitTags(meta["標籤"]),
      uploadDate: meta["上傳日期"] || null,
    });
  }
  return docs;
}

/**
 * FAQ 的欄位區從這些欄位之一開始。回答內文裡也可能出現「申請時間：」「適用對象：」之類的句子
 * （例如進修推廣部場地借用那題，回答第一行就是「適用對象：」），所以只認標準格式裡
 * 一定排在欄位區最前面的這幾個欄位；適用對象、關鍵字等排在後面，不用來判斷起點。
 */
const FAQ_FIELD_START = /^(FAQ 編號|承辦組別|業務主題|資料來源|來源網址|來源日期|維護類型|回答類型)：/;
const FAQ_FIELD = /^([^：\s][^：]{0,15})：\s*(.*)$/;

export function parseFaqMarkdown(markdown: string): FaqEntry[] {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/^### (?!#)/m).slice(1);
  const entries: FaqEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const question = lines.shift()!.trim();
    if (!question) continue;
    const start = lines.findIndex((l) => FAQ_FIELD_START.test(l.trim()));
    const answerLines = start === -1 ? lines : lines.slice(0, start);
    const fieldLines = start === -1 ? [] : lines.slice(start);
    const fields: Record<string, string> = {};
    for (const raw of fieldLines) {
      const m = raw.trim().match(FAQ_FIELD);
      if (m && !(m[1]! in fields)) fields[m[1]!] = m[2]!.trim();
    }
    entries.push({
      question,
      answer: answerLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
      fields,
      details: fieldLines
        .map((l) => l.replace(/\s+$/, ""))
        .filter((l) => l.trim() !== "" && !/^-{3,}$/.test(l.trim()))
        .join("\n"),
    });
  }
  return entries;
}

export function splitKeywords(value: string | undefined): string[] {
  return splitTags(value).slice(0, 50);
}

/** 只轉換明確的西元日期（MM/DD/YYYY、YYYY/MM/DD、YYYY-MM-DD）；民國年或其他寫法回 null，原文另存。 */
export function gregorianDateIso(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  let y: number, m: number, d: number;
  const mdy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const ymd = v.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (mdy) [m, d, y] = [Number(mdy[1]), Number(mdy[2]), Number(mdy[3])];
  else if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else return null;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString();
}

export function parseCatalogFile(json: unknown): CatalogFile {
  const body = (json ?? {}) as { rows?: unknown };
  if (!Array.isArray(body.rows)) throw new Error("catalog rows missing");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const rows: CatalogRow[] = body.rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    const catalog = row.catalog === "academic" || row.catalog === "admin" ? row.catalog : null;
    if (!catalog) throw new Error("catalog row has unknown catalog type");
    return {
      owner: str(row.owner) ?? "",
      title: str(row.title) ?? "",
      tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [],
      fileUrl: singleUrl(str(row.fileUrl)),
      fileType: str(row.fileType),
      updatedDate: str(row.updatedDate),
      sourcePage: singleUrl(str(row.sourcePage)),
      notes: str(row.notes),
      catalog,
      sourceFile: str(row.sourceFile) ?? "",
    };
  });
  return { rows };
}
