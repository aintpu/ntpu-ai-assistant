import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import { MISSING_RUNS_THRESHOLD, runIngestion, type IngestionDeps } from "../../src/ingestion/run-ingestion";
import { ProvenanceSchema } from "../../src/shared/schemas";
import { TestD1 } from "../helpers/d1-shim";
import { FakeStrapi, FixedClock, MemoryRawArchive, publication } from "../helpers/fixtures";

let db: TestD1;
let strapi: FakeStrapi;
let archive: MemoryRawArchive;
let clock: FixedClock;
let deps: IngestionDeps;

beforeEach(() => {
  db = new TestD1();
  strapi = new FakeStrapi([publication(1), publication(2), publication(3)]);
  archive = new MemoryRawArchive();
  clock = new FixedClock();
  deps = { store: new CanonicalStore(db.asD1()), archive, fetch: strapi.fetch, clock, environment: "test" };
});

const run = () => runIngestion(deps, { trigger: "test" });

describe("ingestion vertical slice: ORD announcements", () => {
  it("publishes version 1 for new records with raw evidence", async () => {
    const summary = await run();
    expect(summary).toMatchObject({ status: "success", fetched: 1, published: 3, unchanged: 0, failed: 0 });
    expect(db.count("entities")).toBe(3);
    expect(db.count("record_versions")).toBe(0);
    expect(archive.objects.size).toBe(1);
    const rows = db.rows<{ version: number; raw_snapshot_key: string }>("SELECT version, raw_snapshot_key FROM entities");
    for (const row of rows) {
      expect(row.version).toBe(1);
      expect(archive.objects.has(row.raw_snapshot_key)).toBe(true);
    }
  });

  it("T-001 idempotent repeat: identical content creates no new version", async () => {
    await run();
    clock.advance(3600);
    const second = await run();
    expect(second).toMatchObject({ status: "success", published: 0, unchanged: 3 });
    expect(db.count("record_versions")).toBe(0);
    const verified = db.rows<{ verified_at: string; version: number }>("SELECT verified_at, version FROM entities");
    expect(verified.every((r) => r.version === 1 && r.verified_at === clock.now)).toBe(true);
  });

  it("T-002 changed content: old version kept, current version + 1", async () => {
    await run();
    strapi.items[1] = publication(2, { title: "研發處公告 2（更正）" });
    clock.advance(3600);
    const summary = await run();
    expect(summary).toMatchObject({ published: 1, unchanged: 2 });
    const [history] = db.rows<{ version: number; snapshot_json: string; valid_to: string }>(
      "SELECT version, snapshot_json, valid_to FROM record_versions",
    );
    expect(history!.version).toBe(1);
    expect(JSON.parse(history!.snapshot_json).title).toBe("研發處公告 2");
    expect(history!.valid_to).toBe(clock.now);
    const current = db.rows<{ version: number; title: string }>(
      `SELECT version, title FROM entities WHERE stable_key = '${publication(2)._id}'`,
    );
    expect(current[0]).toEqual({ version: 2, title: "研發處公告 2（更正）" });
  });

  it("T-003 raw-before-canonical: archive failure leaves canonical data unchanged", async () => {
    archive.fail = true;
    const summary = await run();
    expect(summary.status).toBe("failed");
    expect(summary.errors[0]!.code).toBe("RAW_ARCHIVE_FAILED");
    expect(db.count("entities")).toBe(0);
    const [item] = db.rows<{ status: string; error_code: string }>("SELECT status, error_code FROM ingestion_items");
    expect(item).toEqual({ status: "failed", error_code: "RAW_ARCHIVE_FAILED" });
  });

  it("T-004 validation failure: malformed record is quarantined, not published, and traceable", async () => {
    strapi.items.push(publication(4, { title: "   " }));
    const summary = await run();
    expect(summary).toMatchObject({ status: "success", published: 3, quarantined: 1, failed: 0 });
    expect(db.count("entities")).toBe(3);
    const [q] = db.rows<{ stable_key: string; reason: string; raw_snapshot_key: string }>(
      "SELECT stable_key, reason, raw_snapshot_key FROM quarantined_records",
    );
    expect(q!.stable_key).toBe(publication(4)._id);
    expect(q!.reason).toMatch(/title/);
    expect(archive.objects.has(q!.raw_snapshot_key)).toBe(true);
    const [item] = db.rows<{ records_quarantined: number; error_message: string }>(
      "SELECT records_quarantined, error_message FROM ingestion_items",
    );
    expect(item!.records_quarantined).toBe(1);
    expect(item!.error_message).toContain(publication(4)._id);
    const [runRow] = db.rows<{ quarantined_count: number }>("SELECT quarantined_count FROM ingestion_runs");
    expect(runRow!.quarantined_count).toBe(1);
  });

  it("banner carousel items are skipped by rule, not quarantined or counted as failures", async () => {
    // 真實資料：研發處 672 筆中有 17 筆 type=banner，標題與內文皆為空字串。
    strapi.items.push(publication(9, { type: "banner", title: "", content: "", files: [] }));
    const summary = await run();
    expect(summary).toMatchObject({ status: "success", published: 3, skipped: 1, quarantined: 0, failed: 0 });
    expect(db.count("quarantined_records")).toBe(0);
    const [item] = db.rows<{ records_skipped: number; records_parsed: number }>(
      "SELECT records_skipped, records_parsed FROM ingestion_items",
    );
    expect(item).toEqual({ records_skipped: 1, records_parsed: 4 });
    expect(strapi.bodies[0]).toContain("_id type title");
  });

  it("quarantined record is released once the source fixes it, and pruned once it disappears", async () => {
    strapi.items.push(publication(4, { title: "" }), publication(5, { _id: "bad" }));
    await run();
    expect(db.count("quarantined_records")).toBe(2);
    strapi.items[3] = publication(4);
    strapi.items.pop();
    clock.advance(3600);
    await run();
    expect(db.count("quarantined_records")).toBe(0);
    expect(db.count("entities")).toBe(4);
  });

  it("partial run keeps published data but does not count as a complete success", async () => {
    strapi.items = Array.from({ length: 230 }, (_, i) => publication(i + 1));
    await run();
    const firstSuccess = clock.now;
    clock.advance(86_400);
    strapi.items[0] = publication(1, { title: "已更新" });
    const pageFetch = strapi.fetch;
    deps.fetch = async (request) => {
      const body = await request.clone().text();
      if (body.includes("start:200")) return new Response("busy", { status: 503 });
      return pageFetch(request);
    };
    const summary = await run();
    expect(summary).toMatchObject({ status: "partial", fetched: 2, published: 1, unchanged: 199 });
    expect(summary.errors[0]!.code).toBe("FETCH_HTTP_ERROR");
    const [source] = db.rows<{ last_success_at: string; last_attempt_at: string; last_run_status: string }>(
      "SELECT last_success_at, last_attempt_at, last_run_status FROM sources",
    );
    expect(source).toEqual({ last_success_at: firstSuccess, last_attempt_at: clock.now, last_run_status: "partial" });
    // 不完整的執行不判斷資料消失
    const missing = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM entities WHERE missing_runs > 0");
    expect(missing[0]!.n).toBe(0);
    expect(db.count("entities")).toBe(230);
  });

  it("T-004 fails closed when too many records are invalid (parser drift)", async () => {
    await run();
    strapi.items = Array.from({ length: 10 }, (_, i) => publication(i + 1, { title: "" }));
    clock.advance(3600);
    const summary = await run();
    expect(summary.status).toBe("failed");
    expect(summary.errors.some((e) => e.code === "PARSER_DRIFT")).toBe(true);
    expect(db.count("record_versions")).toBe(0);
  });

  it("T-005 parser failure: raw snapshot kept, canonical unchanged, item failed", async () => {
    await run();
    const badFetch = async () =>
      new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } });
    deps.fetch = badFetch;
    clock.advance(86_400);
    const summary = await run();
    expect(summary.status).toBe("failed");
    expect(summary.errors[0]!.code).toBe("PARSE_FAILED");
    expect(archive.objects.size).toBe(2);
    expect(db.count("entities")).toBe(3);
    expect(db.count("record_versions")).toBe(0);
  });

  it("T-006 transaction rollback: no partial history or partial current update", async () => {
    await run();
    strapi.items[0] = publication(1, { title: "變更後" });
    db.failOn = (sql) => sql.trimStart().startsWith("UPDATE entities SET payload_json");
    clock.advance(3600);
    const summary = await run();
    expect(summary.errors.some((e) => e.code === "PUBLISH_FAILED")).toBe(true);
    expect(db.count("record_versions")).toBe(0);
    const [row] = db.rows<{ version: number; title: string }>(
      `SELECT version, title FROM entities WHERE stable_key = '${publication(1)._id}'`,
    );
    expect(row).toEqual({ version: 1, title: "研發處公告 1" });
  });

  it("T-009 provenance completeness: every record has source and snapshot provenance", async () => {
    await run();
    const rows = db.rows<Record<string, string | number>>(
      `SELECT e.*, s.source_type, s.trust_level FROM entities e JOIN sources s ON s.id = e.source_id`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.raw_snapshot_key).toMatch(/^raw\/ord-announcements\/2026\/10\/03\/[0-9a-f]{64}\.bin$/);
      const provenance = ProvenanceSchema.parse({
        sourceId: row.source_id,
        sourceUnit: row.source_unit,
        sourceUrl: row.source_url,
        sourceType: row.source_type,
        trustLevel: row.trust_level,
        version: row.version,
        publishedAt: row.published_at,
        verifiedAt: row.verified_at,
        contentHash: row.content_hash,
      });
      expect(provenance.sourceUrl).toMatch(/^https:\/\/new\.ntpu\.edu\.tw\/ord\/news\/[0-9a-f]{24}$/);
    }
  });

  it("pages through the API until a short page", async () => {
    strapi.items = Array.from({ length: 230 }, (_, i) => publication(i + 1));
    const summary = await run();
    expect(summary).toMatchObject({ status: "success", fetched: 3, published: 230 });
    expect(strapi.bodies.map((b) => /start:(\d+)/.exec(b)?.[1])).toEqual(["0", "100", "200"]);
  });

  it("disappearance: marks inactive only after repeated complete runs, never deletes", async () => {
    await run();
    strapi.items = [publication(1), publication(2)];
    for (let i = 0; i < MISSING_RUNS_THRESHOLD; i++) {
      clock.advance(86_400);
      await run();
      const [row] = db.rows<{ status: string; missing_runs: number }>(
        `SELECT status, missing_runs FROM entities WHERE stable_key = '${publication(3)._id}'`,
      );
      expect(row!.missing_runs).toBe(i + 1);
      expect(row!.status).toBe(i + 1 >= MISSING_RUNS_THRESHOLD ? "inactive" : "active");
    }
    expect(db.count("entities")).toBe(3);
  });

  it("zero records while data exists is treated as drift, not as mass disappearance", async () => {
    await run();
    strapi.items = [];
    clock.advance(86_400);
    const summary = await run();
    expect(summary.errors[0]!.code).toBe("PARSER_DRIFT");
    const statuses = db.rows<{ missing_runs: number }>("SELECT missing_runs FROM entities");
    expect(statuses.every((r) => r.missing_runs === 0)).toBe(true);
  });

  it("records a structured run summary", async () => {
    const summary = await run();
    const [runRow] = db.rows<{ status: string; published_count: number; finished_at: string }>(
      "SELECT status, published_count, finished_at FROM ingestion_runs",
    );
    expect(runRow).toEqual({ status: "success", published_count: 3, finished_at: summary.finishedAt });
    const [source] = db.rows<{ last_success_at: string; last_run_status: string }>(
      "SELECT last_success_at, last_run_status FROM sources",
    );
    expect(source).toEqual({ last_success_at: clock.now, last_run_status: "success" });
    expect(summary.quarantined).toBe(0);
  });
});
