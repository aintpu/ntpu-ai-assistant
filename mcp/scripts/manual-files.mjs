// 人工整理檔（repo 的 crawler_data/）的清單與轉換。upload-manual.mjs 與測試共用。
// xlsx 用 Node 內建 zlib 讀取（xlsx 是 zip 包 XML），不另外安裝套件。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** 原樣上傳的 markdown；必須與 source-registry 的 entrypoints 一致（有測試檢查）。 */
export const MANUAL_MARKDOWN = [
  "crawler_data/oaa_regulations.md",
  "crawler_data/osa_regulations.md",
  "crawler_data/hr_regulations.md",
  "crawler_data/oga_regulations.md",
  "crawler_data/ge_regulations_extra.md",
  "crawler_data/ord_faq.md",
  "crawler_data/oa_faq.md",
  "crawler_data/lib_faq.md",
  "crawler_data/cic_faq.md",
  "crawler_data/oia_faq.md",
  "crawler_data/eec_faq.md",
  "crawler_data/alu_faq.md",
  "crawler_data/sus_faq.md",
  "crawler_data/edusp_faq.md",
  "crawler_data/os_faq.md",
  "crawler_data/pres_faq.md",
  "crawler_data/vpa_faq.md",
  "crawler_data/vpad_faq.md",
  "crawler_data/vpf_faq.md",
  "crawler_data/hr_content.md",
  "crawler_data/oga_content.md",
];

export const CATALOG_PATH = "derived/regulation-catalog.json";
export const ACADEMIC_XLSX = "crawler_data/北大學術單位法規彙整.xlsx";
export const ADMIN_XLSX = "crawler_data/北大行政單位法規彙整.xlsx";

// ── 最小的 zip 讀取（只支援 xlsx 會用到的 store / deflate） ──────────────────
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression ${method}: ${name}`);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
  }
  return files;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function textOf(xml) {
  return decodeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 讀出一個工作表的所有列（字串陣列）。 */
export function readXlsxSheet(buf, sheetName) {
  const files = readZip(buf);
  const get = (name) => {
    const f = files.get(name);
    if (!f) throw new Error(`missing ${name} in xlsx`);
    return f.toString("utf8");
  };
  const workbook = get("xl/workbook.xml");
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decodeXml(m[0].match(/\bname="([^"]*)"/)?.[1] ?? ""),
    rid: m[0].match(/\br:id="([^"]*)"/)?.[1],
  }));
  const sheet = sheetName === undefined ? sheets[0] : sheets.find((s) => s.name === sheetName);
  if (!sheet) throw new Error(`sheet not found: ${sheetName}`);
  const rels = get("xl/_rels/workbook.xml.rels");
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].find((m) => m[0].includes(`Id="${sheet.rid}"`));
  const target = rel?.[0].match(/\bTarget="([^"]*)"/)?.[1];
  if (!target) throw new Error(`sheet target not found: ${sheet.name}`);
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const shared = files.has("xl/sharedStrings.xml")
    ? [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  const rows = [];
  for (const rowMatch of get(path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]*)"/)?.[1];
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = textOf(inner);
      else if (v !== undefined) value = decodeXml(v);
      row[ref ? columnIndex(ref) : row.length] = value.trim();
    }
    rows.push(Array.from(row, (x) => x ?? ""));
  }
  return rows;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function tagsOf(value) {
  return [...new Set((value ?? "").split(/[,，、]/).map((t) => t.trim()).filter(Boolean))];
}

/** 由兩份法規彙整 xlsx 產生統一欄位的 JSON（只轉換格式，內容照原表）。 */
export function buildRegulationCatalog(repoRoot) {
  const academicBuf = readFileSync(join(repoRoot, ACADEMIC_XLSX));
  const adminBuf = readFileSync(join(repoRoot, ADMIN_XLSX));
  const rows = [];

  // 學術單位：用「總表」（其他分頁是同樣資料依單位拆開）。
  const [aHead, ...aRows] = readXlsxSheet(academicBuf, "總表");
  const ai = (name) => {
    const i = aHead.indexOf(name);
    if (i < 0) throw new Error(`academic catalog missing column ${name}`);
    return i;
  };
  const A = {
    owner: ai("所屬單位"),
    title: ai("title"),
    tags: ai("tags"),
    fileUrl: ai("file_url"),
    fileType: ai("file_type"),
    updated: ai("updated_date"),
    page: ai("source_page"),
    notes: ai("notes"),
  };
  for (const r of aRows) {
    if (!r[A.title]) continue;
    rows.push({
      owner: r[A.owner] ?? "",
      title: r[A.title],
      tags: tagsOf(r[A.tags]),
      fileUrl: r[A.fileUrl] || null,
      fileType: r[A.fileType] || null,
      updatedDate: r[A.updated] || null,
      sourcePage: r[A.page] || null,
      notes: r[A.notes] || null,
      catalog: "academic",
      sourceFile: ACADEMIC_XLSX,
    });
  }

  // 行政單位：單一工作表、中文欄名。
  const [dHead, ...dRows] = readXlsxSheet(adminBuf);
  const di = (name) => {
    const i = dHead.indexOf(name);
    if (i < 0) throw new Error(`admin catalog missing column ${name}`);
    return i;
  };
  const D = { owner: di("處室"), title: di("法規名稱"), tags: di("標籤"), updated: di("上傳日期"), fileUrl: di("檔案連結") };
  for (const r of dRows) {
    if (!r[D.title]) continue;
    rows.push({
      owner: r[D.owner] ?? "",
      title: r[D.title],
      tags: tagsOf(r[D.tags]),
      fileUrl: r[D.fileUrl] || null,
      fileType: null,
      updatedDate: r[D.updated] || null,
      sourcePage: null,
      notes: null,
      catalog: "admin",
      sourceFile: ADMIN_XLSX,
    });
  }

  return {
    generatedFrom: [
      { path: ACADEMIC_XLSX, sha256: sha256(academicBuf) },
      { path: ADMIN_XLSX, sha256: sha256(adminBuf) },
    ],
    rows,
  };
}
