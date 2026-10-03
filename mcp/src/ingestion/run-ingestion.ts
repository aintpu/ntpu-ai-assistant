import type { CanonicalStore } from "../db/canonical-store";
import type { Clock } from "../shared/clock";
import { errorCodeOf, IngestionError, safeMessage } from "../shared/errors";
import { contentHash } from "../shared/hash";
import { newId } from "../shared/ids";
import type { Announcement } from "../shared/schemas";
import { fetchSource } from "./fetch-source";
import { normalizeAnnouncement } from "./normalizers/announcement.normalizer";
import { strapiPublicationsParser } from "./parsers/strapi-publications.parser";
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
  failed: number;
  errors: { sourceId: string; target: string; code: string; message: string }[];
}

interface SourceResult {
  fetched: number;
  published: number;
  unchanged: number;
  failed: number;
  failedItems: number;
  okItems: number;
  errors: IngestionRunSummary["errors"];
}

function searchTextOf(a: Announcement): string {
  return [a.title, a.bodyText, ...a.attachments.map((f) => f.name)].join("\n");
}

async function ingestSource(source: SourceDefinition, runId: string, deps: IngestionDeps): Promise<SourceResult> {
  const { store, clock } = deps;
  const parser = strapiPublicationsParser;
  const result: SourceResult = {
    fetched: 0,
    published: 0,
    unchanged: 0,
    failed: 0,
    failedItems: 0,
    okItems: 0,
    errors: [],
  };
  await store.ensureSource(source, clock.nowIso());

  let complete = false;
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
      const invalid: string[] = [];
      for (const row of rows) {
        try {
          valid.push(normalizeAnnouncement(row, source));
        } catch (err) {
          invalid.push(safeMessage(err));
        }
      }
      if (invalid.length > 0) {
        result.failed += invalid.length;
        for (const message of invalid.slice(0, 5)) {
          result.errors.push({ sourceId: source.id, target: request.target, code: "VALIDATION_FAILED", message });
        }
        if (invalid.length > Math.max(5, rows.length * MAX_INVALID_RATIO)) {
          throw new IngestionError("PARSER_DRIFT", `${invalid.length}/${rows.length} records failed validation`);
        }
      }

      // 5. 算 hash、比對、有變動才寫新版本
      for (const record of valid) {
        const hash = await contentHash(record);
        try {
          const outcome = await store.publish(
            {
              entityType: source.entityType,
              stableKey: record.id,
              sourceUnit: source.sourceUnit,
              payload: record,
              title: record.title,
              searchText: searchTextOf(record),
              sourceId: source.id,
              sourceUrl: record.sourceUrl,
              rawSnapshotKey: archived.key,
              contentHash: hash,
              publishedAt: record.publishedAt,
            },
            runId,
            clock.nowIso(),
          );
          if (outcome === "unchanged") item.unchanged++;
          else item.published++;
        } catch (err) {
          result.failed++;
          result.errors.push({
            sourceId: source.id,
            target: request.target,
            code: "PUBLISH_FAILED",
            message: `${record.id}: ${safeMessage(err)}`,
          });
        }
      }
      result.published += item.published;
      result.unchanged += item.unchanged;
      item.status = invalid.length > 0 || item.published + item.unchanged < valid.length ? "partial" : "success";
      result.okItems++;
    } catch (err) {
      item.status = "failed";
      item.errorCode = errorCodeOf(err);
      item.errorMessage = safeMessage(err);
      result.failedItems++;
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

  // 只有整個來源都完整、成功抓完，才能判斷哪些資料從官網消失了。
  const clean = complete && result.failedItems === 0 && result.failed === 0;
  if (clean) await store.markUnseen(source.id, runId, MISSING_RUNS_THRESHOLD);
  const status = result.failedItems > 0 ? "failed" : clean ? "success" : "partial";
  await store.setSourceResult(source.id, status, clock.nowIso(), status !== "failed");
  return result;
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

  const totals = { fetched: 0, published: 0, unchanged: 0, failed: 0 };
  const errors: IngestionRunSummary["errors"] = [];
  let okSources = 0;
  let failedSources = 0;

  // 來源之間互不影響；目前只有一個來源，依序執行即為有界的並行度。
  for (const source of sources) {
    try {
      const r = await ingestSource(source, runId, deps);
      totals.fetched += r.fetched;
      totals.published += r.published;
      totals.unchanged += r.unchanged;
      totals.failed += r.failed + r.failedItems;
      errors.push(...r.errors);
      if (r.failedItems > 0 || r.failed > 0) failedSources++;
      if (r.okItems > 0) okSources++;
    } catch (err) {
      failedSources++;
      totals.failed++;
      errors.push({ sourceId: source.id, target: "*", code: errorCodeOf(err), message: safeMessage(err) });
    }
  }

  const status: IngestionRunSummary["status"] =
    failedSources === 0 ? "success" : okSources === 0 ? "failed" : "partial";
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
