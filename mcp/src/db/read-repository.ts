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

export type ReadEntityType = "announcement" | "page" | "regulation" | "faq";

export interface AnnouncementQuery {
  /** announcement（公告）、page（內容頁）、regulation（法規）或 faq（常見問答）。 */
  entityType?: ReadEntityType;
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
    const params: unknown[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `?${params.length}`;
    };
    const where = [`e.entity_type = ${bind(q.entityType ?? "announcement")}`, `e.status = 'active'`];
    if (q.unit) where.push(`e.source_unit = ${bind(q.unit)}`);
    if (q.fromDate) where.push(`e.published_at >= ${bind(q.fromDate)}`);
    if (q.beforeIso) where.push(`e.published_at < ${bind(q.beforeIso)}`);
    for (const term of q.keywords) {
      // 用 instr 而非 LIKE：D1 限制 LIKE 樣式長度（約 50 bytes），17 個中文字以上的關鍵字會 INTERNAL_ERROR。
      // lower() 保留 LIKE 原本「英文不分大小寫」的行為；instr 不認萬用字元，% 與 _ 照字面比對。
      where.push(`instr(lower(e.search_text), lower(${bind(term)})) > 0`);
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

  /** 同一則公告在各處室各一筆；依 stable_key（處室:_id）一次查出所有處室的那一筆。 */
  async getAnnouncementRows(
    id: string,
    units: string[],
    entityType: ReadEntityType = "announcement",
  ): Promise<AnnouncementRow[]> {
    if (units.length === 0) return [];
    const placeholders = units.map((_, i) => `?${i + 2}`).join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM entities e JOIN sources s ON s.id = e.source_id
         WHERE e.entity_type = ?1 AND e.stable_key IN (${placeholders}) AND e.status != 'withheld'
         ORDER BY e.source_unit`,
      )
      .bind(entityType, ...units.map((u) => `${u}:${id}`))
      .all<AnnouncementRow>();
    return results;
  }

  /**
   * 法規、FAQ 的編號在同類資料裡唯一，但所屬處室由資料決定（stable_key 是「處室:編號」）；
   * 依編號查詢，不必先知道處室。編號格式已由呼叫端驗證，這裡仍跳脫 LIKE 特殊字元。
   */
  async getRowsByRecordId(entityType: ReadEntityType, id: string): Promise<AnnouncementRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM entities e JOIN sources s ON s.id = e.source_id
         WHERE e.entity_type = ?1 AND e.stable_key LIKE ?2 ESCAPE '\\' AND e.status != 'withheld'
         ORDER BY e.source_unit LIMIT 5`,
      )
      .bind(entityType, `%:${escapeLike(id)}`)
      .all<AnnouncementRow>();
    return results.filter((r) => r.stable_key.endsWith(`:${id}`));
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
