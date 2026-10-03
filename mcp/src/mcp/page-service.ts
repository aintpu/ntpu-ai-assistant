import type { AnnouncementRow, ReadRepository } from "../db/read-repository";
import { sourceUnits } from "../ingestion/source-registry";
import { PageSchema, type Page, type Provenance } from "../shared/schemas";
import { provenanceOf, SEARCH_LIMIT_MAX } from "./announcement-service";

const SNIPPET_CHARS = 200;

export interface PageSummary {
  id: string;
  unit: string;
  path: string;
  title: string;
  updatedAt: string;
  snippet: string;
  provenance: Provenance;
}

export interface PageDetail extends Omit<PageSummary, "snippet"> {
  bodyText: string;
  links: Page["links"];
  status: string;
}

/** 讀出的 payload 也要再驗證一次；資料庫內容不符 schema 時寧可不回答。 */
function payloadOf(row: AnnouncementRow): Page | null {
  try {
    const parsed = PageSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 處室固定內容頁（校長室、副校長室介紹等）的唯讀查詢。 */
export class PageService {
  constructor(private readonly repo: ReadRepository) {}

  async search(input: { keyword?: string; unit?: string; limit: number }): Promise<PageSummary[]> {
    const keywords = (input.keyword ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
    const rows = await this.repo.searchAnnouncements({
      entityType: "page",
      unit: input.unit,
      keywords,
      limit: Math.min(input.limit, SEARCH_LIMIT_MAX),
    });
    const items: PageSummary[] = [];
    for (const row of rows) {
      const p = payloadOf(row);
      if (!p) continue;
      items.push({
        id: p.id,
        unit: p.unit,
        path: p.path,
        title: p.title,
        updatedAt: p.updatedAt,
        snippet: p.bodyText.slice(0, SNIPPET_CHARS),
        provenance: provenanceOf(row),
      });
    }
    return items;
  }

  async get(id: string): Promise<PageDetail | null> {
    const rows = await this.repo.getAnnouncementRows(id, sourceUnits("page"), "page");
    for (const row of rows) {
      const p = payloadOf(row);
      if (!p) continue;
      return {
        id: p.id,
        unit: p.unit,
        path: p.path,
        title: p.title,
        updatedAt: p.updatedAt,
        bodyText: p.bodyText,
        links: p.links,
        status: row.status,
        provenance: provenanceOf(row),
      };
    }
    return null;
  }
}
