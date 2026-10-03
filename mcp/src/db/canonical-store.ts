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
  source_url: string;
  raw_snapshot_key: string;
  version: number;
  content_hash: string;
  verified_at: string;
  created_at: string;
  updated_at: string;
}

export type PublishOutcome = "created" | "updated" | "unchanged";

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

  async getEntity(entityType: string, stableKey: string): Promise<StoredEntity | null> {
    return this.db
      .prepare(
        `SELECT id, entity_type, stable_key, payload_json, source_url, raw_snapshot_key, version,
                content_hash, verified_at, created_at, updated_at
         FROM entities WHERE entity_type = ?1 AND stable_key = ?2`,
      )
      .bind(entityType, stableKey)
      .first<StoredEntity>();
  }

  async publish(input: CanonicalInput, runId: string, now: string): Promise<PublishOutcome> {
    const current = await this.getEntity(input.entityType, input.stableKey);
    const id = entityId(input.entityType, input.stableKey);

    if (current && current.content_hash === input.contentHash) {
      await this.db
        .prepare(
          `UPDATE entities SET verified_at = ?2, last_seen_run_id = ?3, missing_runs = 0, status = 'active'
           WHERE id = ?1`,
        )
        .bind(id, now, runId)
        .run();
      return "unchanged";
    }

    const payloadJson = JSON.stringify(input.payload);
    if (!current) {
      await this.db
        .prepare(
          `INSERT INTO entities (id, entity_type, stable_key, source_unit, payload_json, title, search_text,
             source_id, source_url, raw_snapshot_key, version, content_hash, verified_at, published_at,
             status, missing_runs, last_seen_run_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12, ?13, 'active', 0, ?14, ?12, ?12)`,
        )
        .bind(
          id,
          input.entityType,
          input.stableKey,
          input.sourceUnit,
          payloadJson,
          input.title,
          input.searchText,
          input.sourceId,
          input.sourceUrl,
          input.rawSnapshotKey,
          input.contentHash,
          now,
          input.publishedAt,
          runId,
        )
        .run();
      return "created";
    }

    await this.db.batch([
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
          id,
          payloadJson,
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
    ]);
    return "updated";
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

  async quarantine(
    record: { sourceId: string; stableKey: string; reason: string; rawSnapshotKey: string },
    runId: string,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO quarantined_records (source_id, stable_key, reason, raw_snapshot_key, first_seen_at,
           last_seen_at, last_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
         ON CONFLICT(source_id, stable_key) DO UPDATE SET reason = ?3, raw_snapshot_key = ?4,
           last_seen_at = ?5, last_run_id = ?6`,
      )
      .bind(record.sourceId, record.stableKey, record.reason, record.rawSnapshotKey, now, runId)
      .run();
  }

  async quarantinedKeys(sourceId: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare(`SELECT stable_key FROM quarantined_records WHERE source_id = ?1`)
      .bind(sourceId)
      .all<{ stable_key: string }>();
    return new Set(results.map((r) => r.stable_key));
  }

  async releaseFromQuarantine(sourceId: string, stableKey: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM quarantined_records WHERE source_id = ?1 AND stable_key = ?2`)
      .bind(sourceId, stableKey)
      .run();
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
