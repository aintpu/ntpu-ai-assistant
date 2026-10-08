import { extractText, getDocumentProxy } from "unpdf";

export interface PdfText {
  pages: number;
  text: string;
  /** 平均每頁字數很少：多半是掃描檔或純圖片，需要 OCR（第二階段）。 */
  scanned: boolean;
}

/** 平均每頁少於這個字數（不含空白）就視為掃描檔。 */
const SCANNED_CHARS_PER_PAGE = 30;
/** 超過這個頁數只取前面的頁（避免單一檔案用掉整次執行的 CPU）。 */
export const MAX_PDF_PAGES = 200;

/**
 * 用 PDF.js（unpdf）逐頁抽出文字。表格內容也會抽出（Cloudflare toMarkdown 會丟掉表格，
 * 2026-10-08 實測招生簡章只剩一半文字、系所考科全部遺失，所以不用 toMarkdown）。
 */
export async function pdfText(bytes: Uint8Array): Promise<PdfText> {
  const pdf = await getDocumentProxy(bytes.slice());
  const pages = pdf.numPages;
  const result = await extractText(pdf, { mergePages: false });
  const texts = (result.text as string[]).slice(0, MAX_PDF_PAGES);
  const text = texts
    .map((t, i) => `【第 ${i + 1} 頁】\n${t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()}`)
    .join("\n\n");
  const chars = texts.join("").replace(/\s+/g, "").length;
  return { pages, text, scanned: chars < SCANNED_CHARS_PER_PAGE * Math.max(1, Math.min(pages, MAX_PDF_PAGES)) };
}
