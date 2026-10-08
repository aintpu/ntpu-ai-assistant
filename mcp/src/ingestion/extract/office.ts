import { unzipSync } from "fflate";
import { IngestionError } from "../../shared/errors";

/** 解壓縮後單一檔案的上限（防 zip bomb）。 */
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

const ENTRIES: Record<string, string> = {
  odt: "content.xml",
  ods: "content.xml",
  odp: "content.xml",
  docx: "word/document.xml",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** ODF／DOCX 的 XML 轉純文字：段落、標題、表格儲存格換行或以 Tab 分隔，其餘標籤去掉。 */
export function xmlToText(xml: string): string {
  // 表格儲存格裡的段落以空白相連，同一列的欄位才不會被換行拆開（招生簡章的考科多在表格裡）
  const cells = xml.replace(
    /<(table:table-cell|w:tc)\b[^>]*>([\s\S]*?)<\/\1>/g,
    (_m, tag: string, inner: string) => `<${tag}>${inner.replace(/<\/(?:text:p|text:h|w:p)>/g, " ")}</${tag}>`,
  );
  const text = cells
    .replace(/<text:tab\/>|<w:tab\/>/g, "\t")
    .replace(/<text:line-break\/>|<w:br\/>/g, "\n")
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => " ".repeat(Number(n ?? 1)))
    .replace(/<\/(?:text:p|text:h|w:p)>/g, "\n")
    .replace(/<\/(?:table:table-cell|w:tc)>/g, "\t")
    .replace(/<\/(?:table:table-row|w:tr)>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/ +\t/g, "\t")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 解出 ODT／ODS／ODP／DOCX 的內文。 */
export function officeText(bytes: Uint8Array, ext: string): string {
  const entry = ENTRIES[ext];
  if (!entry) throw new IngestionError("PARSE_FAILED", `unsupported office type: ${ext}`);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.name !== entry) return false;
        if (f.originalSize > MAX_ENTRY_BYTES) throw new IngestionError("FETCH_TOO_LARGE", "office entry too large");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof IngestionError) throw err;
    throw new IngestionError("PARSE_FAILED", `not a valid ${ext} file`);
  }
  const xml = files[entry];
  if (!xml) throw new IngestionError("PARSE_FAILED", `${entry} missing`);
  return xmlToText(new TextDecoder("utf-8").decode(xml));
}
