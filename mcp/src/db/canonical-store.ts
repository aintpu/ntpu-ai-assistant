import { newId } from "../shared/ids";
import type { SourceDefinition } from "../ingestion/types";

export interface CanonicalInput {
  entityType: string;
  stableKey: string;
  sourceUnit: string;
  payload: unknown;
  title: string;
  searchText: string;
  sourceId: string;
  sourceUrl: string;
  rawSnapshotKey: string;
  contentHash: string;
  publishedAt: string | null;
}

export interface StoredEntity {
  id: string;
  entity_type: string;
  stable_key: string;
  payload_json: string;
  raw_snapshot_key: string;
  version: number;
  content_hash: string;
  updated_at: string;
}

export interface PublishCounts {
  created: number;
  updated: number;
  unchanged: number;
}

/** D1 每個查詢最多 100 個 bind 參數。 */
const MAX_IN_PARAMS = 90;
const INSERT_ROWS_PER_STATEMENT = 6;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 公告的 stable_key：同一則公告（相同 _id）在不同處室各自一筆。 */
export function announcementKey(unit: string, id: string): string {
  return `${unit}:${id}`;
}

export function entityId(entityType: string, stableKey: string): string {
  return `${entityType}:${stableKey}`;
}

/**
 * 抓取流程寫入正式資料庫的唯一入口（規格 06 §21）。所有 SQL 都用 bind 參數。
 * 內容有變動時，「舊版本存進 record_versions」與「更新目前版本」在同一個 D1 batch
 * 裡完成；D1 batch 是交易，任何一步失敗就整批回復。
 */
export class CanonicalStore {
  constructor(private readonly db: D1Database) {}

  async ensureSource(source: SourceDefinition, now: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sources (id, source_unit, source_url, source_type, trust_level, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET source_unit = ?2, source_url = ?3, source_type = ?4,
           trust_level = ?5, updated_at = ?6`,
      )
      .bind(source.id, source.sourceUnit, source.homepageUrl, source.sourceType, source.trustLevel, now)
      .run();
  }

  /**
   * 一頁資料的比對與寫入（規格 06 §15、§21）。為了符合 Cloudflare 的限制
   * （每次執行的 D1 查詢數、每個查詢最多 100 個 bind 參數），整頁只用：
   *   1 次讀取目前 hash（分段 IN 查詢）＋ 1 個 D1 batch 寫入。
   * D1 batch 是交易：整頁的「舊版存入 record_versions」與「更新目前版本」一起成功或一起回復。
   */
  async publishPage(inputs: CanonicalInput[], runId: string, now: string): Promise<PublishCounts> {
    const counts: PublishCounts = { created: 0, updated: 0, unchanged: 0 };
    if (inputs.length === 0) return counts;
    const entityType = inputs[0]!.entityType;
    if (inputs.some((i) => i.entityType !== entityType)) throw new Error("mixed entity types in one page");

    const current = new Map<string, StoredEntity>();
    for (const keys of chunk(inputs.map((i) => i.stableKey), MAX_IN_PARAMS)) {
      const placeholders = keys.map((_, i) => `?${i + 2}`).join(", ");
      const { results } = await this.db
        .prepare(
          `SELECT id, entity_type, stable_key, payload_json, raw_snapshot_key, version, content_hash, updated_at
           FROM entities WHERE entity_type = ?1 AND stable_key IN (${placeholders})`,
        )
        .bind(entityType, ...keys)
        .all<StoredEntity>();
      for (const row of results) current.set(row.stable_key, row);
    }

    const statements: D1PreparedStatement[] = [];
    const unchangedIds: string[] = [];
    const created: CanonicalInput[] = [];
    for (const input of inputs) {
      const existing = current.get(input.stableKey);
      if (existing && existing.content_hash === input.contentHash) {
        unchangedIds.push(existing.id);
        counts.unchanged++;
      } else if (!existing) {
        created.push(input);
        counts.created++;
      } else {
        statements.push(...this.versionStatements(existing, input, runId, now));
        counts.updated++;
      }
    }

    for (const ids of chunk(unchangedIds, MAX_IN_PARAMS)) {
      const placeholders = ids.map((_, i) => `?${i + 3}`).join(", ");
      statements.push(
        this.db
          .prepare(
            `UPDATE entities SET verified_at = ?1, last_seen_run_id = ?2, missing_runs = 0, status = 'active'
             WHERE id IN (${placeholders})`,
          )
          .bind(now, runId, ...ids),
      );
    }

    // 新資料用多列 INSERT；每列 14 個參數，一個查詢最多 6 列（84 個參數）。
    for (const rows of chunk(created, INSERT_ROWS_PER_STATEMENT)) {
      const values: unknown[] = [];
      const tuples = rows.map((input) => {
        const base = values.length;
        values.push(
          entityId(input.entityType, input.stableKey),
          input.entityType,
          input.stableKey,
          input.sourceUnit,
          JSON.stringify(input.payload),
          input.title,
          input.searchText,
          input.sourceId,
          input.sourceUrl,
          input.rawSnapshotKey,
          input.contentHash,
          now,
          input.publishedAt,
          runId,
        );
        const p = (n: number) => `?${base + n}`;
        return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, 1, ${p(11)}, ${p(12)}, ${p(13)}, 'active', 0, ${p(14)}, ${p(12)}, ${p(12)})`;
      });
      statements.push(
        this.db
          .prepare(
            `INSERT INTO entities (id, entity_type, stable_key, source_unit, payload_json, title, search_text,
               source_id, source_url, raw_snapshot_key, version, content_hash, verified_at, published_at,
               status, missing_runs, last_seen_run_id, created_at, updated_at)
             VALUES ${tuples.join(", ")}`,
          )
          .bind(...values),
      );
    }

    if (statements.length > 0) await this.db.batch(statements);
    return counts;
  }

  private versionStatements(
    current: StoredEntity,
    input: CanonicalInput,
    runId: string,
    now: string,
  ): D1PreparedStatement[] {
    return [
      // 舊版本存進 record_versions；UNIQUE(entity_type, entity_id, version) 讓同時寫入的衝突整批回復。
      this.db
        .prepare(
          `INSERT INTO record_versions (id, entity_type, entity_id, version, snapshot_json, content_hash,
             raw_snapshot_key, valid_from, valid_to, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
        )
        .bind(
          newId("ver"),
          current.entity_type,
          current.id,
          current.version,
          current.payload_json,
          current.content_hash,
          current.raw_snapshot_key,
          current.updated_at,
          now,
        ),
      this.db
        .prepare(
          `UPDATE entities SET payload_json = ?2, title = ?3, search_text = ?4, source_url = ?5,
             raw_snapshot_key = ?6, version = version + 1, content_hash = ?7, verified_at = ?8,
             published_at = ?9, status = 'active', missing_runs = 0, last_seen_run_id = ?10, updated_at = ?8
           WHERE id = ?1 AND version = ?11`,
        )
        .bind(
          current.id,
          JSON.stringify(input.payload),
          input.title,
          input.searchText,
          input.sourceUrl,
          input.rawSnapshotKey,
          input.contentHash,
          now,
          input.publishedAt,
          runId,
          current.version,
        ),
    ];
  }

  /** 排程挑選來源時用：每個來源的最近嘗試時間。 */
  async sourceSchedule(): Promise<{ id: string; last_started_at: string | null }[]> {
    const { results } = await this.db
      .prepare(`SELECT id, last_started_at FROM sources`)
      .all<{ id: string; last_started_at: string | null }>();
    return results;
  }

  /** 開始抓取前先記錄，下一次排程就不會再挑同一個來源。 */
  async markStarted(sourceId: string, now: string): Promise<void> {
    await this.db
      .prepare(`UPDATE sources SET last_started_at = ?2, updated_at = ?2 WHERE id = ?1`)
      .bind(sourceId, now)
      .run();
  }

  async countActive(sourceId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM entities WHERE source_id = ?1 AND status = 'active'`)
      .bind(sourceId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * 這次完整抓取沒看到的資料：累計 missing_runs，連續 threshold 次才標記 inactive。
   * 不刪除任何資料（規格 06 §37）。
   */
  async markUnseen(sourceId: string, runId: string, threshold: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE entities SET missing_runs = missing_runs + 1,
           status = CASE WHEN missing_runs + 1 >= ?3 THEN 'inactive' ELSE status END
         WHERE source_id = ?1 AND (last_seen_run_id IS NULL OR last_seen_run_id != ?2)`,
      )
      .bind(sourceId, runId, threshold)
      .run();
    return result.meta.changes ?? 0;
  }

  /**
   * 記錄來源這次執行的結果。last_success_at 只在「完整成功」時更新；
   * 部分成功只更新 last_attempt_at 與 last_run_status，避免把未完整驗證的來源標成最新。
   */
  async setSourceResult(sourceId: string, status: "success" | "partial" | "failed", now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sources SET last_run_status = ?2, last_attempt_at = ?3, updated_at = ?3,
           last_success_at = CASE WHEN ?2 = 'success' THEN ?3 ELSE last_success_at END
         WHERE id = ?1`,
      )
      .bind(sourceId, status, now)
      .run();
  }

  async quarantineMany(
    records: { sourceId: string; stableKey: string; reason: string; rawSnapshotKey: string }[],
    runId: string,
    now: string,
  ): Promise<void> {
    if (records.length === 0) return;
    await this.db.batch(
      records.map((r) =>
        this.db
          .prepare(
            `INSERT INTO quarantined_records (source_id, stable_key, reason, raw_snapshot_key, first_seen_at,
               last_seen_at, last_run_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
             ON CONFLICT(source_id, stable_key) DO UPDATE SET reason = ?3, raw_snapshot_key = ?4,
               last_seen_at = ?5, last_run_id = ?6`,
          )
          .bind(r.sourceId, r.stableKey, r.reason, r.rawSnapshotKey, now, runId),
      ),
    );
  }

  async quarantinedKeys(sourceId: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare(`SELECT stable_key FROM quarantined_records WHERE source_id = ?1`)
      .bind(sourceId)
      .all<{ stable_key: string }>();
    return new Set(results.map((r) => r.stable_key));
  }

  async releaseFromQuarantine(sourceId: string, stableKeys: string[]): Promise<void> {
    for (const keys of chunk(stableKeys, MAX_IN_PARAMS)) {
      const placeholders = keys.map((_, i) => `?${i + 2}`).join(", ");
      await this.db
        .prepare(`DELETE FROM quarantined_records WHERE source_id = ?1 AND stable_key IN (${placeholders})`)
        .bind(sourceId, ...keys)
        .run();
    }
  }

  /** 完整執行後，這次沒再出現的隔離紀錄代表來源已移除該筆資料，從隔離區清掉。 */
  async pruneQuarantine(sourceId: string, runId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM quarantined_records WHERE source_id = ?1 AND last_run_id != ?2`)
      .bind(sourceId, runId)
      .run();
  }

  async createRun(runId: string, environment: string, trigger: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ingestion_runs (id, environment, trigger_type, started_at, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'running', ?4)`,
      )
      .bind(runId, environment, trigger, now)
      .run();
  }

  async finishRun(
    runId: string,
    summary: {
      status: string;
      sourceCount: number;
      fetched: number;
      published: number;
      unchanged: number;
      failed: number;
      quarantined: number;
      skipped: number;
      errors: unknown[];
    },
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE ingestion_runs SET finished_at = ?2, status = ?3, source_count = ?4, fetched_count = ?5,
           published_count = ?6, unchanged_count = ?7, failed_count = ?8, error_summary_json = ?9,
           quarantined_count = ?10, skipped_count = ?11
         WHERE id = ?1`,
      )
      .bind(
        runId,
        now,
        summary.status,
        summary.sourceCount,
        summary.fetched,
        summary.published,
        summary.unchanged,
        summary.failed,
        summary.errors.length ? JSON.stringify(summary.errors.slice(0, 50)) : null,
        summary.quarantined,
        summary.skipped,
      )
      .run();
  }

  async recordItem(item: {
    runId: string;
    sourceId: string;
    target: string;
    status: string;
    httpStatus: number | null;
    rawSnapshotKey: string | null;
    rawHash: string | null;
    parsed: number;
    published: number;
    unchanged: number;
    quarantined: number;
    skipped: number;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ingestion_items (id, run_id, source_id, target, status, http_status, raw_snapshot_key,
           raw_hash, records_parsed, records_published, records_unchanged, error_code, error_message,
           started_at, finished_at, records_quarantined, records_skipped)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .bind(
        newId("item"),
        item.runId,
        item.sourceId,
        item.target,
        item.status,
        item.httpStatus,
        item.rawSnapshotKey,
        item.rawHash,
        item.parsed,
        item.published,
        item.unchanged,
        item.errorCode,
        item.errorMessage,
        item.startedAt,
        item.finishedAt,
        item.quarantined,
        item.skipped,
      )
      .run();
  }
}
