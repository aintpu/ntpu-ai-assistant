import { recordKey, type CanonicalInput, type CanonicalStore } from "../db/canonical-store";
import type { Clock } from "../shared/clock";
import { errorCodeOf, IngestionError, safeMessage } from "../shared/errors";
import { contentHash } from "../shared/hash";
import { newId } from "../shared/ids";
import { adapterFor } from "./adapters";
import type { KnownRecord, Step, StepContext } from "./adapters/types";
import { fetchSource } from "./fetch-source";
import { enabledSources, getSource } from "./source-registry";
import type { FetchLike, RawArchive, SourceDefinition } from "./types";

/** 連續幾次完整抓取都沒看到，才把資料標成 inactive。 */
export const MISSING_RUNS_THRESHOLD = 3;
/** 一頁裡不合格的資料超過這個比例，就判定解析可能出錯，整頁不寫入。 */
const MAX_INVALID_RATIO = 0.2;
/**
 * 單次執行最多送出幾個請求。每個請求另有 R2 寫入與 D1 查詢，Cloudflare 對單次執行的
 * 子請求數有上限（付費方案 1000）；超過的內文留到下一次執行。
 */
export const MAX_REQUESTS_PER_RUN = 200;

export interface IngestionDeps {
  store: CanonicalStore;
  archive: RawArchive;
  fetch: FetchLike;
  clock: Clock;
  environment: string;
  /** 請求之間的等待；測試可換成不等待。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface IngestionRunOptions {
  sourceIds?: string[];
  /**
   * 重新驗證在這個時間之前驗證過的所有內文（例如過濾規則更新後，填規則更新的時間）。
   * 仍受每次上限限制，分批完成；同一個時間重複執行，直到 deferred 為 0。
   */
  reverifyBefore?: string;
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
  /** 驗證不通過或含個人資料、未寫入正式資料而記在 quarantined_records 的筆數。 */
  quarantined: number;
  /** 依來源規則排除、本來就不是公告的項目（例如首頁輪播 banner、連到外部網站的列表項目）。 */
  skipped: number;
  /** 需要抓內文但超過單次上限、留到下一次執行的數量。 */
  deferred: number;
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
  deferred: number;
  errors: IngestionRunSummary["errors"];
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ingestSource(
  source: SourceDefinition,
  runId: string,
  deps: IngestionDeps,
  reverifyBefore?: string,
): Promise<SourceResult> {
  const { store, clock } = deps;
  const sleep = deps.sleep ?? realSleep;
  const result: SourceResult = {
    status: "failed",
    fetched: 0,
    published: 0,
    unchanged: 0,
    failed: 0,
    quarantined: 0,
    skipped: 0,
    deferred: 0,
    errors: [],
  };
  await store.ensureSource(source, clock.nowIso());
  await store.markStarted(source.id, clock.nowIso());
  const quarantined = await store.quarantinedRecords(source.id);

  const ctx: StepContext = {
    source,
    nowIso: clock.nowIso(),
    reverifyBefore,
    activeCount: () => store.countActive(source.id),
    async known(ids) {
      const map = new Map<string, KnownRecord>();
      const stored = await store.knownRecords(source.entityType, ids.map((id) => recordKey(source, id)));
      for (const id of ids) {
        const row = stored.get(recordKey(source, id));
        if (row) map.set(id, row);
        else {
          const q = quarantined.get(id);
          if (q) map.set(id, { title: null, publishedAt: null, verifiedAt: q });
        }
      }
      return map;
    },
  };

  const queue: Step[] = adapterFor(source).start(source, clock.nowIso());
  let listComplete = false;
  let fatalFailure = false;
  let failedSteps = 0;
  let requests = 0;

  while (queue.length > 0) {
    if (requests >= MAX_REQUESTS_PER_RUN) {
      result.deferred += queue.length;
      break;
    }
    const step = queue.shift()!;
    if (requests > 0 && source.fetch.minIntervalMs > 0) await sleep(source.fetch.minIntervalMs);
    requests++;
    const startedAt = clock.nowIso();
    const item = {
      runId,
      sourceId: source.id,
      target: step.request.target,
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
    try {
      // 1. 抓取（只會連到來源設定允許的網址）
      const snapshot = await fetchSource(source, step.request, deps);
      item.httpStatus = snapshot.httpStatus;
      item.rawHash = snapshot.rawHash;
      result.fetched++;

      // 2. 原始檔先存，存不進去就不往下做（規格 06 §9.1）
      const archived = await deps.archive.put(snapshot).catch((err: unknown) => {
        if (err instanceof IngestionError) throw err;
        throw new IngestionError("RAW_ARCHIVE_FAILED", `raw archive failed: ${safeMessage(err)}`);
      });
      item.rawSnapshotKey = archived.key;

      // 3. 解析、正規化與驗證：全部驗完再決定要不要寫入
      const outcome = await step.handle(snapshot.bytes, ctx);
      item.parsed = outcome.parsed;
      item.skipped = outcome.skipped;
      result.skipped += outcome.skipped;
      const invalid = outcome.rejected.filter((r) => r.countsTowardDrift).length;
      const candidates = outcome.parsed - outcome.skipped;
      if (invalid > Math.max(5, candidates * MAX_INVALID_RATIO)) {
        throw new IngestionError("PARSER_DRIFT", `${invalid}/${candidates} records failed validation`);
      }

      // 不合格或含個人資料：不寫入正式資料，記到隔離區，原始檔仍可追溯。
      await store.quarantineMany(
        outcome.rejected.map((r) => ({
          sourceId: source.id,
          stableKey: r.id,
          reason: r.reason,
          rawSnapshotKey: archived.key,
        })),
        runId,
        clock.nowIso(),
      );
      // 之前已收錄、這次被擋下的資料：不再提供（例如規則更新後才發現含個人資料）。
      await store.withhold(
        source.entityType,
        outcome.rejected.map((r) => recordKey(source, r.id)),
        runId,
        clock.nowIso(),
      );
      item.quarantined = outcome.rejected.length;
      result.quarantined += outcome.rejected.length;

      // 列表上看到、這次沒重抓內文的資料：仍在官網上，不算消失。
      if (outcome.seenIds?.length) {
        await store.markSeen(
          source.id,
          source.entityType,
          outcome.seenIds.map((id) => ({ stableKey: recordKey(source, id), sourceKey: id })),
          runId,
        );
      }

      // 4. 算 hash、比對、有變動才寫新版本；整頁一個交易。
      // stable_key 用「處室:編號」：同一則公告刊在多個處室時，各處室各自一筆、各自追蹤。
      const inputs: CanonicalInput[] = [];
      for (const record of outcome.records) {
        inputs.push({
          entityType: source.entityType,
          stableKey: recordKey(source, record.id),
          sourceUnit: source.sourceUnit,
          payload: record.payload,
          title: record.title,
          searchText: record.searchText,
          sourceId: source.id,
          sourceUrl: record.sourceUrl,
          rawSnapshotKey: archived.key,
          contentHash: await contentHash(record.payload),
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
          outcome.records.map((r) => r.id).filter((id) => quarantined.has(id)),
        );
      } catch (err) {
        publishFailures = outcome.records.length;
        failedSteps++;
        result.errors.push({
          sourceId: source.id,
          target: step.request.target,
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
      } else if (outcome.rejected.length > 0) {
        item.errorCode = "VALIDATION_FAILED";
        item.errorMessage = `quarantined ${outcome.rejected.length}: ${outcome.rejected
          .map((r) => r.id)
          .join(", ")}`.slice(0, 500);
      }
      if (publishFailures > 0 && step.fatal) fatalFailure = true;
      if (outcome.listComplete) listComplete = true;
      result.deferred += outcome.deferred ?? 0;
      queue.push(...(outcome.next ?? []));
    } catch (err) {
      item.status = "failed";
      item.errorCode = errorCodeOf(err);
      item.errorMessage = safeMessage(err);
      failedSteps++;
      result.errors.push({
        sourceId: source.id,
        target: step.request.target,
        code: item.errorCode,
        message: item.errorMessage,
      });
      if (step.fatal) fatalFailure = true;
    }
    item.finishedAt = clock.nowIso();
    await store.recordItem(item);
    if (fatalFailure) break;
  }

  // 列表完整走完、且列表頁都成功，才判斷哪些資料從官網消失（規格 06 §37）。
  // 完整成功＝列表走完、每個請求都成功、沒有留到下一次的內文；只有完整成功才更新 last_success_at。
  if (listComplete && !fatalFailure) {
    await store.markUnseen(source.id, runId, MISSING_RUNS_THRESHOLD);
    await store.pruneQuarantine(source.id, runId);
  }
  const okSteps = result.fetched - failedSteps;
  if (listComplete && failedSteps === 0 && result.failed === 0 && result.deferred === 0) {
    result.status = "success";
  } else {
    result.status = okSteps > 0 || result.published + result.unchanged > 0 ? "partial" : "failed";
  }
  await store.setSourceResult(source.id, result.status, clock.nowIso(), result.deferred);
  return result;
}

/** 同一來源兩次抓取之間至少間隔多久（每天一次，留緩衝）。 */
export const MIN_SOURCE_INTERVAL_SECONDS = 20 * 60 * 60;
/** 上次還有內文沒抓完的來源，隔多久可以接著抓（大於單次執行時間，避免同時執行）。 */
export const PENDING_RETRY_SECONDS = 15 * 60;

/**
 * Cron 每 10 分鐘觸發一次，每次只挑一個「到期」的來源，避免單次執行超過 Cloudflare 的
 * 執行時間與 D1 查詢次數限制。從沒跑過的優先，其次是上次還有內文沒抓完的，再來是最久沒跑的；
 * 都還沒到期就回傳 null。
 */
export async function pickDueSource(
  store: CanonicalStore,
  now: string,
  minIntervalSeconds = MIN_SOURCE_INTERVAL_SECONDS,
): Promise<SourceDefinition | null> {
  const rows = new Map((await store.sourceSchedule()).map((r) => [r.id, r]));
  const nowMs = Date.parse(now);
  let best: { source: SourceDefinition; rank: number; at: number } | null = null;
  for (const source of enabledSources()) {
    const row = rows.get(source.id);
    const at = row?.last_started_at ? Date.parse(row.last_started_at) : Number.NEGATIVE_INFINITY;
    const pending = (row?.pending_count ?? 0) > 0;
    let rank: number;
    if (at === Number.NEGATIVE_INFINITY) rank = 0;
    else if (pending && at <= nowMs - PENDING_RETRY_SECONDS * 1000) rank = 1;
    else if (at <= nowMs - minIntervalSeconds * 1000) rank = 2;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && at < best.at)) best = { source, rank, at };
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

  const totals = { fetched: 0, published: 0, unchanged: 0, failed: 0, quarantined: 0, skipped: 0, deferred: 0 };
  const errors: IngestionRunSummary["errors"] = [];
  let okSources = 0;
  let partialSources = 0;
  let failedSources = 0;

  // 來源之間互不影響；排程每次只跑一個來源，依序執行即為有界的並行度。
  for (const source of sources) {
    try {
      const r = await ingestSource(source, runId, deps, options.reverifyBefore);
      totals.fetched += r.fetched;
      totals.published += r.published;
      totals.unchanged += r.unchanged;
      totals.failed += r.errors.length;
      totals.quarantined += r.quarantined;
      totals.skipped += r.skipped;
      totals.deferred += r.deferred;
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
