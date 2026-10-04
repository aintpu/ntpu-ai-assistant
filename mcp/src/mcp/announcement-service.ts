import type { AnnouncementRow, ReadEntityType, ReadRepository } from "../db/read-repository";
import { SOURCES, sourceCovers, sourceUnits } from "../ingestion/source-registry";
import type { Clock } from "../shared/clock";
import { freshnessOf, type FreshnessState } from "../shared/freshness";
import { AnnouncementSchema, type Announcement, type Provenance } from "../shared/schemas";

export const SEARCH_LIMIT_MAX = 20;
const SNIPPET_CHARS = 200;
const DEDUPE_FACTOR = 3;

export interface SourceFreshness {
  sourceId: string;
  unit: string;
  /** 依「最近一次完整成功」判斷。 */
  state: FreshnessState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastRunStatus: string | null;
  /** 驗證不通過、未收錄的來源資料筆數。 */
  quarantinedCount: number;
}

/** 給 MCP client 的警示：資料過期，或最近一次抓取沒有完整成功。 */
export function warningsOf(freshness: SourceFreshness[]): string[] {
  const warnings: string[] = [];
  if (freshness.some((f) => f.state !== "fresh")) warnings.push("DATA_STALE");
  if (freshness.some((f) => f.lastRunStatus === "partial" || f.lastRunStatus === "failed")) {
    warnings.push("INGESTION_INCOMPLETE");
  }
  return warnings;
}

export interface AnnouncementSummary {
  id: string;
  unit: string;
  /** 同一則公告也刊登在哪些處室（search 為本次查詢結果範圍內）。 */
  postedBy: string[];
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

export function provenanceOf(row: AnnouncementRow): Provenance {
  return {
    sourceId: row.source_id,
    sourceUnit: row.source_unit,
    sourceUrl: row.source_url || null,
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

  async freshness(unit?: string, entityType: ReadEntityType = "announcement"): Promise<SourceFreshness[]> {
    const rows = await this.repo.sourceStatuses();
    const now = this.clock.nowIso();
    return SOURCES.filter((s) => s.entityType === entityType && (!unit || sourceCovers(s, unit))).map((s) => {
      const row = rows.find((r) => r.id === s.id);
      const lastSuccessAt = row?.last_success_at ?? null;
      return {
        sourceId: s.id,
        unit: s.sourceUnit,
        state: freshnessOf(lastSuccessAt, s.freshness.maxStalenessSeconds, now),
        lastSuccessAt,
        lastAttemptAt: row?.last_attempt_at ?? null,
        lastRunStatus: row?.last_run_status ?? null,
        quarantinedCount: Number(row?.quarantined ?? 0),
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
      // 跨處室重複的公告只回一筆，所以多抓一些再合併。
      limit: Math.min(input.limit, SEARCH_LIMIT_MAX) * DEDUPE_FACTOR,
    });
    const items: AnnouncementSummary[] = [];
    const byId = new Map<string, AnnouncementSummary>();
    for (const row of rows) {
      const payload = payloadOf(row);
      if (!payload) continue;
      const seen = byId.get(payload.id);
      if (seen) {
        if (!seen.postedBy.includes(payload.unit)) seen.postedBy.push(payload.unit);
        continue;
      }
      if (items.length >= Math.min(input.limit, SEARCH_LIMIT_MAX)) continue;
      const item: AnnouncementSummary = {
        id: payload.id,
        unit: payload.unit,
        postedBy: [payload.unit],
        title: payload.title,
        publishedAt: row.published_at,
        snippet: payload.bodyText.slice(0, SNIPPET_CHARS),
        attachmentCount: payload.attachments.length,
        provenance: provenanceOf(row),
      };
      byId.set(payload.id, item);
      items.push(item);
    }
    for (const item of items) item.postedBy.sort();
    return items;
  }

  /** unit 指定時回該處室那一筆；沒指定就回第一個處室的那一筆，並列出所有刊登處室。 */
  async get(id: string, unit?: string): Promise<AnnouncementDetail | null> {
    const rows = await this.repo.getAnnouncementRows(id, unit ? [unit] : sourceUnits("announcement"));
    const valid = rows.flatMap((row) => {
      const payload = payloadOf(row);
      return payload ? [{ row, payload }] : [];
    });
    // 某處室已下架、其他處室仍刊登時，優先回仍刊登的那一筆。
    valid.sort((a, b) => Number(b.row.status === "active") - Number(a.row.status === "active"));
    const first = valid[0];
    if (!first) return null;
    const { row, payload } = first;
    return {
      id: payload.id,
      unit: payload.unit,
      postedBy: unit ? [payload.unit] : valid.map((v) => v.payload.unit),
      title: payload.title,
      publishedAt: row.published_at,
      bodyText: payload.bodyText,
      attachments: payload.attachments,
      status: row.status,
      provenance: provenanceOf(row),
    };
  }
}
