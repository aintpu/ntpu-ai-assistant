import type { AnnouncementRow, ReadRepository } from "../db/read-repository";
import { unitName } from "../ingestion/source-registry";
import { FaqSchema, RegulationSchema, type Faq, type Provenance, type Regulation } from "../shared/schemas";
import { provenanceOf, SEARCH_LIMIT_MAX } from "./announcement-service";

const SNIPPET_CHARS = 200;

/** 讀出的 payload 也要再驗證一次；資料庫內容不符 schema 時寧可不回答。 */
function parsePayload<T>(row: AnnouncementRow, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? (parsed.data as T) : null;
  } catch {
    return null;
  }
}

function keywordsOf(keyword?: string): string[] {
  return (keyword ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
}

export interface RegulationSummary {
  id: string;
  unit: string;
  owner: string;
  title: string;
  hasFullText: boolean;
  fileUrl: string | null;
  tags: string[];
  updatedDate: string | null;
  /** 給人看的來源名稱（純文字）。provenance.sourceUrl 為 null 時，用這個標示來源。 */
  sourceName: string;
  snippet: string;
  provenance: Provenance;
}

export interface RegulationDetail extends Omit<RegulationSummary, "snippet"> {
  bodyText: string;
  status: string;
}

function regulationSummary(r: Regulation, row: AnnouncementRow): RegulationSummary {
  return {
    id: r.id,
    unit: r.unit,
    owner: r.owner,
    title: r.title,
    hasFullText: r.hasFullText,
    fileUrl: r.fileUrl,
    tags: r.tags,
    updatedDate: r.updatedDate,
    sourceName: r.hasFullText ? `${r.owner}法規（人工整理資料）` : `${r.owner}法規彙整表（人工整理資料）`,
    snippet: r.bodyText.slice(0, SNIPPET_CHARS),
    provenance: provenanceOf(row),
  };
}

/** 法規（人工整理的全文檔與法規彙整表）的唯讀查詢。 */
export class RegulationService {
  constructor(private readonly repo: ReadRepository) {}

  async search(input: { keyword?: string; unit?: string; limit: number }): Promise<RegulationSummary[]> {
    const rows = await this.repo.searchAnnouncements({
      entityType: "regulation",
      unit: input.unit,
      keywords: keywordsOf(input.keyword),
      limit: Math.min(input.limit, SEARCH_LIMIT_MAX),
    });
    return rows.flatMap((row) => {
      const r = parsePayload<Regulation>(row, RegulationSchema);
      return r ? [regulationSummary(r, row)] : [];
    });
  }

  async get(id: string): Promise<RegulationDetail | null> {
    for (const row of await this.repo.getRowsByRecordId("regulation", id)) {
      const r = parsePayload<Regulation>(row, RegulationSchema);
      if (!r) continue;
      const { snippet: _snippet, ...summary } = regulationSummary(r, row);
      return { ...summary, bodyText: r.bodyText, status: row.status };
    }
    return null;
  }
}

export interface FaqSummary {
  id: string;
  unit: string;
  question: string;
  topic: string | null;
  division: string | null;
  sourceDate: string | null;
  /** 給人看的來源名稱（純文字）。provenance.sourceUrl 為 null 時，用這個標示來源。 */
  sourceName: string;
  snippet: string;
  provenance: Provenance;
}

export interface FaqDetail extends Omit<FaqSummary, "snippet"> {
  answer: string;
  keywords: string[];
  details: string;
  status: string;
}

function faqSummary(f: Faq, row: AnnouncementRow): FaqSummary {
  return {
    id: f.id,
    unit: f.unit,
    question: f.question,
    topic: f.topic,
    division: f.division,
    sourceDate: f.sourceDate,
    sourceName: `${unitName(f.unit) ?? f.unit}常見問答（人工整理資料）`,
    snippet: f.answer.slice(0, SNIPPET_CHARS),
    provenance: provenanceOf(row),
  };
}

/** 各處室常見問答（人工整理檔）的唯讀查詢。 */
export class FaqService {
  constructor(private readonly repo: ReadRepository) {}

  async search(input: { keyword?: string; unit?: string; limit: number }): Promise<FaqSummary[]> {
    const rows = await this.repo.searchAnnouncements({
      entityType: "faq",
      unit: input.unit,
      keywords: keywordsOf(input.keyword),
      limit: Math.min(input.limit, SEARCH_LIMIT_MAX),
    });
    return rows.flatMap((row) => {
      const f = parsePayload<Faq>(row, FaqSchema);
      return f ? [faqSummary(f, row)] : [];
    });
  }

  async get(id: string): Promise<FaqDetail | null> {
    for (const row of await this.repo.getRowsByRecordId("faq", id)) {
      const f = parsePayload<Faq>(row, FaqSchema);
      if (!f) continue;
      const { snippet: _snippet, ...summary } = faqSummary(f, row);
      return { ...summary, answer: f.answer, keywords: f.keywords, details: f.details, status: row.status };
    }
    return null;
  }
}
