import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import {
  MIN_SOURCE_INTERVAL_SECONDS,
  pickDueSource,
  runIngestion,
  type IngestionDeps,
} from "../../src/ingestion/run-ingestion";
import { enabledSources } from "../../src/ingestion/source-registry";
import { TestD1 } from "../helpers/d1-shim";
import { FakeStrapi, FixedClock, MemoryRawArchive, publication } from "../helpers/fixtures";

let db: TestD1;
let store: CanonicalStore;
let clock: FixedClock;
let deps: IngestionDeps;
const shared = publication(9, { title: "跨處室公告" });

beforeEach(() => {
  db = new TestD1();
  store = new CanonicalStore(db.asD1());
  clock = new FixedClock();
  const strapi = new FakeStrapi([], {
    ord_ntpu: [publication(1), shared],
    osa_ntpu: [publication(2), shared],
  });
  deps = { store, archive: new MemoryRawArchive(), fetch: strapi.fetch, clock, environment: "test" };
});

describe("all offices", () => {
  it("registers every office with announcements, each with its own site key", () => {
    const sources = enabledSources();
    expect(new Set(sources.map((s) => s.sourceUnit)).size).toBe(21);
    const strapi = sources.flatMap((s) => (s.adapter.kind === "strapi-publications" ? [s.adapter.siteKey] : []));
    expect(strapi).toHaveLength(15);
    expect(new Set(strapi).size).toBe(15);
    expect(sources.map((s) => s.sourceUnit)).toEqual(expect.arrayContaining(["op", "library", "lc", "president"]));
  });

  it("a cross-posted announcement is stored once per office, and changes in one office do not touch the other", async () => {
    await runIngestion(deps, { sourceIds: ["ord-announcements", "osa-announcements"], trigger: "test" });
    const rows = db.rows<{ id: string; stable_key: string; source_url: string }>(
      `SELECT id, stable_key, source_url FROM entities WHERE stable_key LIKE '%${shared._id}' ORDER BY stable_key`,
    );
    expect(rows).toEqual([
      {
        id: `announcement:ord:${shared._id}`,
        stable_key: `ord:${shared._id}`,
        source_url: `https://new.ntpu.edu.tw/ord/news/${shared._id}`,
      },
      {
        id: `announcement:osa:${shared._id}`,
        stable_key: `osa:${shared._id}`,
        source_url: `https://new.ntpu.edu.tw/osa/news/${shared._id}`,
      },
    ]);

    // 學務處把這則下架三次：只有學務處那筆變 inactive，研發處那筆不受影響。
    deps.fetch = new FakeStrapi([], { ord_ntpu: [publication(1), shared], osa_ntpu: [publication(2)] }).fetch;
    for (let i = 0; i < 3; i++) {
      clock.advance(86_400);
      await runIngestion(deps, { sourceIds: ["osa-announcements"], trigger: "test" });
    }
    const statuses = db.rows<{ stable_key: string; status: string }>(
      `SELECT stable_key, status FROM entities WHERE stable_key LIKE '%${shared._id}' ORDER BY stable_key`,
    );
    expect(statuses.map((r) => r.status)).toEqual(["active", "inactive"]);
  });

  it("offices whose announcements live on their own site link there (sustainable → esdg)", async () => {
    deps.fetch = new FakeStrapi([], { sustainable_ntpu: [publication(5)] }).fetch;
    await runIngestion(deps, { sourceIds: ["sustainable-announcements"], trigger: "test" });
    const [row] = db.rows<{ source_url: string }>("SELECT source_url FROM entities");
    expect(row!.source_url).toBe(`https://esdg.ntpu.edu.tw/news/${publication(5)._id}`);
    for (const source of enabledSources().filter((s) => s.parser === "strapi-publications")) {
      expect(source.newsUrlBase).toMatch(/^https:\/\/[a-z]+\.ntpu\.edu\.tw\/[a-z/]+[^/]$/);
    }
  });

  it("the personal-data guard is on for every office and withholds already-published lists", async () => {
    const { getSource } = await import("../../src/ingestion/source-registry");
    const osa = getSource("osa-announcements")!;
    if (osa.adapter.kind !== "strapi-publications") throw new Error("unexpected adapter");
    expect(osa.adapter.personalDataGuard).toBe(true);
    const list = publication(2, { title: "宿舍續住資格結果", content: "<p>411234567 412345678 410987654</p>" });
    deps.fetch = new FakeStrapi([], { osa_ntpu: [publication(1), list] }).fetch;
    // 模擬過濾開啟前已經收錄的情況。
    osa.adapter.personalDataGuard = false;
    try {
      await runIngestion(deps, { sourceIds: ["osa-announcements"], trigger: "test" });
    } finally {
      osa.adapter.personalDataGuard = true;
    }
    expect(db.rows(`SELECT status FROM entities WHERE stable_key = 'osa:${list._id}'`)).toEqual([{ status: "active" }]);
    clock.advance(86_400);
    const summary = await runIngestion(deps, { sourceIds: ["osa-announcements"], trigger: "test" });
    expect(summary).toMatchObject({ status: "success", quarantined: 1, failed: 0 });
    expect(db.rows(`SELECT status FROM entities WHERE stable_key = 'osa:${list._id}'`)).toEqual([
      { status: "withheld" },
    ]);
    expect(db.rows(`SELECT status FROM entities WHERE stable_key = 'osa:${publication(1)._id}'`)).toEqual([
      { status: "active" },
    ]);
  });

  it("an office with no announcements completes successfully with zero records", async () => {
    const summary = await runIngestion(deps, { sourceIds: ["cic-announcements"], trigger: "test" });
    expect(summary).toMatchObject({ status: "success", fetched: 1, published: 0, failed: 0 });
  });
});

describe("one office per cron run", () => {
  it("picks never-run offices first, then the oldest, and skips offices run in the last 20 hours", async () => {
    const order = enabledSources().map((s) => s.id);
    const seen: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const due = await pickDueSource(store, clock.nowIso());
      expect(due).not.toBeNull();
      seen.push(due!.id);
      await runIngestion(deps, { sourceIds: [due!.id], trigger: "test" });
      clock.advance(600);
    }
    expect([...seen].sort()).toEqual([...order].sort());
    expect(await pickDueSource(store, clock.nowIso())).toBeNull();

    clock.advance(MIN_SOURCE_INTERVAL_SECONDS);
    expect((await pickDueSource(store, clock.nowIso()))!.id).toBe(seen[0]);
  });

  it("an office whose run crashed is not retried until it is due again", async () => {
    deps.fetch = async () => {
      throw new Error("network down");
    };
    const first = (await pickDueSource(store, clock.nowIso()))!;
    await runIngestion(deps, { sourceIds: [first.id], trigger: "test" });
    clock.advance(600);
    expect((await pickDueSource(store, clock.nowIso()))!.id).not.toBe(first.id);
  });
});

describe("migration 0003", () => {
  it("re-keys existing announcements per office without touching content or history", () => {
    const old = new TestD1("0002_quarantine_and_run_status.sql");
    const now = "2026-10-03T00:00:00.000Z";
    old.sqlite.exec(`INSERT INTO sources (id, source_unit, source_url, source_type, created_at, updated_at)
      VALUES ('ord-announcements', 'ord', 'https://new.ntpu.edu.tw/ord/news', 'official_api', '${now}', '${now}')`);
    old.sqlite.exec(`INSERT INTO entities (id, entity_type, stable_key, source_unit, payload_json, title, search_text,
        source_id, source_url, raw_snapshot_key, version, content_hash, verified_at, created_at, updated_at)
      VALUES ('announcement:abc', 'announcement', 'abc', 'ord', '{}', 't', 't', 'ord-announcements',
        'https://new.ntpu.edu.tw/ord/news/abc', 'raw/x', 2, 'h2', '${now}', '${now}', '${now}')`);
    old.sqlite.exec(`INSERT INTO record_versions (id, entity_type, entity_id, version, snapshot_json, content_hash,
        raw_snapshot_key, valid_from, created_at)
      VALUES ('ver_1', 'announcement', 'announcement:abc', 1, '{}', 'h1', 'raw/w', '${now}', '${now}')`);

    for (const file of TestD1.migrations().filter((f) => f > "0002_quarantine_and_run_status.sql")) old.migrate(file);

    expect(old.rows("SELECT id, stable_key, version, content_hash FROM entities")).toEqual([
      { id: "announcement:ord:abc", stable_key: "ord:abc", version: 2, content_hash: "h2" },
    ]);
    expect(old.rows("SELECT entity_id, version FROM record_versions")).toEqual([
      { entity_id: "announcement:ord:abc", version: 1 },
    ]);
  });
});
