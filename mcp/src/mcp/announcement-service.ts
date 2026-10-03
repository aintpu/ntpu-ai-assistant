import type { AnnouncementRow, ReadRepository } from "../db/read-repository";
import { SOURCES } from "../ingestion/source-registry";
import type { Clock } from "../shared/clock";
import { freshnessOf, type FreshnessState } from "../shared/freshness";
import { AnnouncementSchema, type Announcement, type Provenance } from "../shared/schemas";

export const SEARCH_LIMIT_MAX = 20;
const SNIPPET_CHARS = 200;

export interface SourceFreshness {
  sourceId: string;
  unit: string;
  state: FreshnessState;
  lastSuccessAt: string | null;
}

export interface AnnouncementSummary {
  id: string;
  unit: string;
  title: string;
  publishedAt: string | null;
  snippet: string;
  attachmentCount: number;
  provenance: Provenance;
}

export interface AnnouncementDetail extends Omit<AnnouncementSummary, "snippet" | "attachmentCount"> {
  bodyText: string;
  attachments: Announcement["attachments"];
  status: string;
}

function provenanceOf(row: AnnouncementRow): Provenance {
  return {
    sourceId: row.source_id,
    sourceUnit: row.source_unit,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    trustLevel: row.trust_level,
    version: row.version,
    publishedAt: row.published_at,
    verifiedAt: row.verified_at,
    contentHash: row.content_hash,
  };
}

/** 讀出的 payload 也要再驗證一次；資料庫內容不符 schema 時寧可不回答。 */
function payloadOf(row: AnnouncementRow): Announcement | null {
  try {
    const parsed = AnnouncementSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class AnnouncementService {
  constructor(
    private readonly repo: ReadRepository,
    private readonly clock: Clock,
  ) {}

  async freshness(unit?: string): Promise<SourceFreshness[]> {
    const rows = await this.repo.sourceStatuses();
    const now = this.clock.nowIso();
    return SOURCES.filter((s) => s.entityType === "announcement" && (!unit || s.sourceUnit === unit)).map((s) => {
      const row = rows.find((r) => r.id === s.id);
      const lastSuccessAt = row?.last_success_at ?? null;
      return {
        sourceId: s.id,
        unit: s.sourceUnit,
        state: freshnessOf(lastSuccessAt, s.freshness.maxStalenessSeconds, now),
        lastSuccessAt,
      };
    });
  }

  async search(input: {
    keyword?: string;
    unit?: string;
    fromDate?: string;
    toDate?: string;
    limit: number;
  }): Promise<AnnouncementSummary[]> {
    const keywords = (input.keyword ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
    let beforeIso: string | undefined;
    if (input.toDate) {
      const next = new Date(`${input.toDate}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      beforeIso = next.toISOString();
    }
    const rows = await this.repo.searchAnnouncements({
      unit: input.unit,
      keywords,
      fromDate: input.fromDate ? `${input.fromDate}T00:00:00.000Z` : undefined,
      beforeIso,
      limit: Math.min(input.limit, SEARCH_LIMIT_MAX),
    });
    const items: AnnouncementSummary[] = [];
    for (const row of rows) {
      const payload = payloadOf(row);
      if (!payload) continue;
      items.push({
        id: payload.id,
        unit: payload.unit,
        title: payload.title,
        publishedAt: row.published_at,
        snippet: payload.bodyText.slice(0, SNIPPET_CHARS),
        attachmentCount: payload.attachments.length,
        provenance: provenanceOf(row),
      });
    }
    return items;
  }

  async get(id: string): Promise<AnnouncementDetail | null> {
    const row = await this.repo.getAnnouncement(id);
    if (!row) return null;
    const payload = payloadOf(row);
    if (!payload) return null;
    return {
      id: payload.id,
      unit: payload.unit,
      title: payload.title,
      publishedAt: row.published_at,
      bodyText: payload.bodyText,
      attachments: payload.attachments,
      status: row.status,
      provenance: provenanceOf(row),
    };
  }
}
