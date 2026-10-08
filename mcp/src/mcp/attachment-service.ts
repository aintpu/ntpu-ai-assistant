import type { AnnouncementRow, ReadRepository } from "../db/read-repository";
import { AttachmentDocSchema, type AttachmentDoc, type Provenance } from "../shared/schemas";
import { provenanceOf, SEARCH_LIMIT_MAX } from "./announcement-service";

const SNIPPET_CHARS = 300;
/** get_attachment 回傳的全文上限（避免單一回應過大）；完整內容請開原檔。 */
export const ATTACHMENT_TEXT_MAX = 30_000;

export interface AttachmentSummary {
  id: string;
  unit: string;
  postedBy: string[];
  name: string;
  url: string;
  fileType: string;
  announcementId: string;
  announcementTitle: string;
  publishedAt: string | null;
  method: AttachmentDoc["method"];
  extracted: boolean;
  note: string | null;
  pages: number | null;
  snippet: string;
  provenance: Provenance;
}

export interface AttachmentDetail extends Omit<AttachmentSummary, "snippet"> {
  text: string;
  truncated: boolean;
  status: string;
}

function parse(row: AnnouncementRow): AttachmentDoc | null {
  try {
    const parsed = AttachmentDocSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 摘要取第一個關鍵字前後的段落（附件文字通常很長，開頭多半是封面或標題）。 */
export function snippetAround(text: string, keywords: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  let at = -1;
  for (const k of keywords) {
    const i = lower.indexOf(k.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 80);
  return (start > 0 ? "…" : "") + flat.slice(start, start + SNIPPET_CHARS);
}

function summary(a: AttachmentDoc, row: AnnouncementRow, keywords: string[]): AttachmentSummary {
  const { text, ...rest } = a;
  return { ...rest, snippet: snippetAround(text, keywords), provenance: provenanceOf(row) };
}

/** 公告附件內容的唯讀查詢（含個人資料的附件不在資料庫中，只在隔離區）。 */
export class AttachmentService {
  constructor(private readonly repo: ReadRepository) {}

  async search(input: { keyword?: string; unit?: string; limit: number }): Promise<AttachmentSummary[]> {
    const keywords = (input.keyword ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
    const rows = await this.repo.searchAnnouncements({
      entityType: "attachment",
      unit: input.unit,
      keywords,
      limit: Math.min(input.limit, SEARCH_LIMIT_MAX),
    });
    return rows.flatMap((row) => {
      const a = parse(row);
      return a ? [summary(a, row, keywords)] : [];
    });
  }

  async get(id: string): Promise<AttachmentDetail | null> {
    for (const row of await this.repo.getRowsByRecordId("attachment", id)) {
      const a = parse(row);
      if (!a) continue;
      const { snippet: _snippet, ...rest } = summary(a, row, []);
      return {
        ...rest,
        text: a.text.slice(0, ATTACHMENT_TEXT_MAX),
        truncated: a.text.length > ATTACHMENT_TEXT_MAX,
        status: row.status,
      };
    }
    return null;
  }
}
