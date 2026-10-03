import { announcementKey, type CanonicalInput, type CanonicalStore } from "../db/canonical-store";
import type { Clock } from "../shared/clock";
import { errorCodeOf, IngestionError, safeMessage } from "../shared/errors";
import { contentHash } from "../shared/hash";
import { newId } from "../shared/ids";
import type { Announcement } from "../shared/schemas";
import { fetchSource } from "./fetch-source";
import { normalizeAnnouncement } from "./normalizers/announcement.normalizer";
import { strapiPublicationsParser, type StrapiPublication } from "./parsers/strapi-publications.parser";
import { enabledSources, getSource } from "./source-registry";
import type { FetchLike, RawArchive, SourceDefinition } from "./types";

/** 連續幾次完整抓取都沒看到，才把資料標成 inactive。 */
export const MISSING_RUNS_THRESHOLD = 3;
/** 一頁裡不合格的資料超過這個比例，就判定解析可能出錯，整頁不寫入。 */
const MAX_INVALID_RATIO = 0.2;

export interface IngestionDeps {
  store: CanonicalStore;
  archive: RawArchive;
  fetch: FetchLike;
  clock: Clock;
  environment: string;
}

export interface IngestionRunOptions {
  sourceIds?: string[];
  trigger?: "scheduled" | "manual" | "test";
}

export interface IngestionRunSummary {
  type: "ingestion_run";
  runId: string;
  environment: string;
  status: "success" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  sourceCount: number;
  fetched: number;
  published: number;
  unchanged: number;
  /** 抓取、解析或寫入失敗的數量（頁面或資料筆數）。 */
  failed: number;
  /** 驗證不通過、未寫入正式資料而記在 quarantined_records 的筆數。 */
  quarantined: number;
  /** 依來源規則排除、本來就不是公告的項目（例如首頁輪播 banner）。 */
  skipped: number;
  errors: { sourceId: string; target: string; code: string; message: string }[];
}

interface SourceResult {
  status: "success" | "partial" | "failed";
  fetched: number;
  published: number;
  unchanged: number;
  failed: number;
  quarantined: number;
  skipped: number;
  errors: IngestionRunSummary["errors"];
}

function searchTextOf(a: Announcement): string {
  return [a.title, a.bodyText, ...a.attachments.map((f) => f.name)].join("\n");
}

/** 隔離紀錄的識別值：優先用來源的 _id，沒有就用頁碼與位置，確保每筆都追得到原始檔。 */
function quarantineKey(row: StrapiPublication, page: number, index: number): string {
  const id = typeof row._id === "string" ? row._id.trim().slice(0, 100) : "";
  return id || `page-${page}-row-${index}`;
}

async function ingestSource(source: SourceDefinition, runId: string, deps: IngestionDeps): Promise<SourceResult> {
  const { store, clock } = deps;
  const parser = strapiPublicationsParser;
  const result: SourceResult = {
    status: "failed",
    fetched: 0,
    published: 0,
    unchanged: 0,
    failed: 0,
    quarantined: 0,
    skipped: 0,
    errors: [],
  };
  await store.ensureSource(source, clock.nowIso());
  await store.markStarted(source.id, clock.nowIso());
  const previouslyQuarantined = await store.quarantinedKeys(source.id);

  let complete = false;
  let failedPages = 0;
  for (let page = 0; page < parser.maxPages; page++) {
    const startedAt = clock.nowIso();
    const request = parser.buildRequest(source, page, startedAt);
    const item = {
      runId,
      sourceId: source.id,
      target: request.target,
      status: "failed",
      httpStatus: null as number | null,
      rawSnapshotKey: null as string | null,
      rawHash: null as string | null,
      parsed: 0,
      published: 0,
      unchanged: 0,
      quarantined: 0,
      skipped: 0,
      errorCode: null as string | null,
      errorMessage: null as string | null,
      startedAt,
      finishedAt: startedAt,
    };
    let pageSize = 0;
    try {
      // 1. 抓取（只會連到來源設定允許的網址）
      const snapshot = await fetchSource(source, request, deps);
      item.httpStatus = snapshot.httpStatus;
      item.rawHash = snapshot.rawHash;
      result.fetched++;

      // 2. 原始檔先存，存不進去就不往下做（規格 06 §9.1）
      const archived = await deps.archive.put(snapshot).catch((err: unknown) => {
        if (err instanceof IngestionError) throw err;
        throw new IngestionError("RAW_ARCHIVE_FAILED", `raw archive failed: ${safeMessage(err)}`);
      });
      item.rawSnapshotKey = archived.key;

      // 3. 解析
      const rows = parser.parse(snapshot.bytes);
      pageSize = rows.length;
      item.parsed = rows.length;
      if (page === 0 && rows.length === 0 && (await store.countActive(source.id)) > 0) {
        throw new IngestionError("PARSER_DRIFT", "source returned zero records but canonical data exists");
      }

      // 4. 正規化與驗證：全部驗完再決定要不要寫入
      const valid: Announcement[] = [];
      const invalid: { key: string; reason: string }[] = [];
      rows.forEach((row, index) => {
        if (parser.exclusionReason(row)) {
          item.skipped++;
          return;
        }
        try {
          valid.push(normalizeAnnouncement(row, source));
        } catch (err) {
          invalid.push({ key: quarantineKey(row, page, index), reason: safeMessage(err) });
        }
      });
      result.skipped += item.skipped;
      const candidates = rows.length - item.skipped;
      if (invalid.length > Math.max(5, candidates * MAX_INVALID_RATIO)) {
        throw new IngestionError("PARSER_DRIFT", `${invalid.length}/${candidates} records failed validation`);
      }
      // 少量不合格資料：不寫入正式資料，記到隔離區，原始檔仍可追溯。
      await store.quarantineMany(
        invalid.map((bad) => ({
          sourceId: source.id,
          stableKey: bad.key,
          reason: bad.reason,
          rawSnapshotKey: archived.key,
        })),
        runId,
        clock.nowIso(),
      );
      item.quarantined = invalid.length;
      result.quarantined += invalid.length;

      // 5. 算 hash、比對、有變動才寫新版本；整頁一個交易。
      // stable_key 用「處室:_id」：同一則公告刊在多個處室時，各處室各自一筆、各自追蹤。
      const inputs: CanonicalInput[] = [];
      for (const record of valid) {
        inputs.push({
          entityType: source.entityType,
          stableKey: announcementKey(source.sourceUnit, record.id),
          sourceUnit: source.sourceUnit,
          payload: record,
          title: record.title,
          searchText: searchTextOf(record),
          sourceId: source.id,
          sourceUrl: record.sourceUrl,
          rawSnapshotKey: archived.key,
          contentHash: await contentHash(record),
          publishedAt: record.publishedAt,
        });
      }
      let publishFailures = 0;
      try {
        const counts = await store.publishPage(inputs, runId, clock.nowIso());
        item.published = counts.created + counts.updated;
        item.unchanged = counts.unchanged;
        await store.releaseFromQuarantine(
          source.id,
          valid.map((r) => r.id).filter((id) => previouslyQuarantined.has(id)),
        );
      } catch (err) {
        publishFailures = valid.length;
        failedPages++;
        result.errors.push({
          sourceId: source.id,
          target: request.target,
          code: "PUBLISH_FAILED",
          message: safeMessage(err),
        });
      }
      result.failed += publishFailures;
      result.published += item.published;
      result.unchanged += item.unchanged;
      item.status = publishFailures > 0 ? "failed" : "success";
      if (publishFailures > 0) {
        item.errorCode = "PUBLISH_FAILED";
        item.errorMessage = result.errors.at(-1)?.message ?? null;
      } else if (invalid.length > 0) {
        item.errorCode = "VALIDATION_FAILED";
        item.errorMessage = `quarantined ${invalid.length}: ${invalid.map((b) => b.key).join(", ")}`.slice(0, 500);
      }
    } catch (err) {
      item.status = "failed";
      item.errorCode = errorCodeOf(err);
      item.errorMessage = safeMessage(err);
      failedPages++;
      result.errors.push({
        sourceId: source.id,
        target: request.target,
        code: item.errorCode,
        message: item.errorMessage,
      });
      item.finishedAt = clock.nowIso();
      await store.recordItem(item);
      break;
    }
    item.finishedAt = clock.nowIso();
    await store.recordItem(item);
    if (pageSize < parser.pageSize) {
      complete = true;
      break;
    }
  }

  // 完整成功＝每一頁都抓到、解析、寫入成功（隔離的資料不算失敗，但會在摘要中列出）。
  // 只有完整成功才判斷哪些資料從官網消失，也才更新 last_success_at。
  const okPages = result.fetched - failedPages;
  if (complete && failedPages === 0 && result.failed === 0) {
    result.status = "success";
    await store.markUnseen(source.id, runId, MISSING_RUNS_THRESHOLD);
    await store.pruneQuarantine(source.id, runId);
  } else {
    result.status = okPages > 0 || result.published + result.unchanged > 0 ? "partial" : "failed";
  }
  await store.setSourceResult(source.id, result.status, clock.nowIso());
  return result;
}

/** 同一來源兩次抓取之間至少間隔多久（每天一次，留緩衝）。 */
export const MIN_SOURCE_INTERVAL_SECONDS = 20 * 60 * 60;

/**
 * Cron 每 10 分鐘觸發一次，每次只挑一個「到期」的來源，避免單次執行超過 Cloudflare 的
 * 執行時間與 D1 查詢次數限制。從沒跑過的優先，其次是最久沒跑的；都還沒到期就回傳 null。
 */
export async function pickDueSource(
  store: CanonicalStore,
  now: string,
  minIntervalSeconds = MIN_SOURCE_INTERVAL_SECONDS,
): Promise<SourceDefinition | null> {
  const started = new Map((await store.sourceSchedule()).map((r) => [r.id, r.last_started_at]));
  const cutoff = Date.parse(now) - minIntervalSeconds * 1000;
  let best: { source: SourceDefinition; at: number } | null = null;
  for (const source of enabledSources()) {
    const last = started.get(source.id);
    const at = last ? Date.parse(last) : Number.NEGATIVE_INFINITY;
    if (at > cutoff) continue;
    if (!best || at < best.at) best = { source, at };
  }
  return best?.source ?? null;
}

export async function runIngestion(
  deps: IngestionDeps,
  options: IngestionRunOptions = {},
): Promise<IngestionRunSummary> {
  const sources = options.sourceIds
    ? options.sourceIds.map((id) => {
        const source = getSource(id);
        if (!source) throw new IngestionError("SOURCE_NOT_REGISTERED", `unknown source: ${id}`);
        if (!source.enabled) throw new IngestionError("SOURCE_DISABLED", `source disabled: ${id}`);
        return source;
      })
    : enabledSources();

  const runId = newId("run");
  const startedAt = deps.clock.nowIso();
  await deps.store.createRun(runId, deps.environment, options.trigger ?? "manual", startedAt);

  const totals = { fetched: 0, published: 0, unchanged: 0, failed: 0, quarantined: 0, skipped: 0 };
  const errors: IngestionRunSummary["errors"] = [];
  let okSources = 0;
  let partialSources = 0;
  let failedSources = 0;

  // 來源之間互不影響；目前只有一個來源，依序執行即為有界的並行度。
  for (const source of sources) {
    try {
      const r = await ingestSource(source, runId, deps);
      totals.fetched += r.fetched;
      totals.published += r.published;
      totals.unchanged += r.unchanged;
      totals.failed += r.errors.length;
      totals.quarantined += r.quarantined;
      totals.skipped += r.skipped;
      errors.push(...r.errors);
      if (r.status === "success") okSources++;
      else if (r.status === "partial") partialSources++;
      else failedSources++;
    } catch (err) {
      failedSources++;
      totals.failed++;
      errors.push({ sourceId: source.id, target: "*", code: errorCodeOf(err), message: safeMessage(err) });
    }
  }

  const status: IngestionRunSummary["status"] =
    failedSources === 0 && partialSources === 0
      ? "success"
      : okSources === 0 && partialSources === 0
        ? "failed"
        : "partial";
  const finishedAt = deps.clock.nowIso();
  const summary: IngestionRunSummary = {
    type: "ingestion_run",
    runId,
    environment: deps.environment,
    status,
    startedAt,
    finishedAt,
    sourceCount: sources.length,
    ...totals,
    errors,
  };
  await deps.store.finishRun(runId, { ...summary, errors }, finishedAt);
  return summary;
}
