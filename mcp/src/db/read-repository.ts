export interface AnnouncementRow {
  stable_key: string;
  source_unit: string;
  payload_json: string;
  source_id: string;
  source_url: string;
  version: number;
  content_hash: string;
  verified_at: string;
  published_at: string | null;
  status: string;
  source_type: string;
  trust_level: string;
}

export interface SourceStatusRow {
  id: string;
  source_unit: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_run_status: string | null;
  quarantined: number;
}

export interface AnnouncementQuery {
  unit?: string;
  keywords: string[];
  fromDate?: string;
  /** 不含當天之後：toDate 的隔天 00:00 UTC。 */
  beforeIso?: string;
  limit: number;
}

const ROW_COLUMNS = `e.stable_key, e.source_unit, e.payload_json, e.source_id, e.source_url, e.version,
  e.content_hash, e.verified_at, e.published_at, e.status, s.source_type, s.trust_level`;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** MCP 查詢用的唯讀 repository；只有 SELECT，參數一律 bind。 */
export class ReadRepository {
  constructor(private readonly db: D1Database) {}

  async searchAnnouncements(q: AnnouncementQuery): Promise<AnnouncementRow[]> {
    const where = [`e.entity_type = 'announcement'`, `e.status = 'active'`];
    const params: unknown[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `?${params.length}`;
    };
    if (q.unit) where.push(`e.source_unit = ${bind(q.unit)}`);
    if (q.fromDate) where.push(`e.published_at >= ${bind(q.fromDate)}`);
    if (q.beforeIso) where.push(`e.published_at < ${bind(q.beforeIso)}`);
    for (const term of q.keywords) {
      where.push(`e.search_text LIKE ${bind(`%${escapeLike(term)}%`)} ESCAPE '\\'`);
    }
    const sql = `SELECT ${ROW_COLUMNS} FROM entities e JOIN sources s ON s.id = e.source_id
      WHERE ${where.join(" AND ")}
      ORDER BY e.published_at DESC, e.stable_key ASC
      LIMIT ${bind(q.limit)}`;
    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all<AnnouncementRow>();
    return results;
  }

  async getAnnouncement(id: string): Promise<AnnouncementRow | null> {
    return this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM entities e JOIN sources s ON s.id = e.source_id
         WHERE e.entity_type = 'announcement' AND e.stable_key = ?1`,
      )
      .bind(id)
      .first<AnnouncementRow>();
  }

  async sourceStatuses(): Promise<SourceStatusRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.id, s.source_unit, s.last_success_at, s.last_attempt_at, s.last_run_status,
                (SELECT COUNT(*) FROM quarantined_records q WHERE q.source_id = s.id) AS quarantined
         FROM sources s ORDER BY s.id`,
      )
      .all<SourceStatusRow>();
    return results;
  }
}
