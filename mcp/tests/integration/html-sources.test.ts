import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import { fetchSource } from "../../src/ingestion/fetch-source";
import { pickDueSource, runIngestion, type IngestionDeps } from "../../src/ingestion/run-ingestion";
import { getSource } from "../../src/ingestion/source-registry";
import { TestD1 } from "../helpers/d1-shim";
import { FakeStrapi, FixedClock, MemoryRawArchive, routedFetch, section } from "../helpers/fixtures";
import { FakeSites, lcId, libraryId, type FakeNews } from "../helpers/html-fixtures";

let db: TestD1;
let clock: FixedClock;
let sites: FakeSites;
let strapi: FakeStrapi;
let sleeps: number[];
let deps: IngestionDeps;

function libraryNews(n: number, overrides: Partial<FakeNews> = {}): FakeNews {
  return {
    id: libraryId(n),
    title: `圖書館公告 ${n}`,
    date: `2026-09-${String((n % 28) + 1).padStart(2, "0")}`,
    body: `<p>第 ${n} 則圖書館公告內文。</p>`,
    ...overrides,
  };
}

function lcNews(n: number, overrides: Partial<FakeNews> = {}): FakeNews {
  return { ...libraryNews(n), id: lcId(n), title: `語言中心公告 ${n}`, ...overrides };
}

beforeEach(() => {
  db = new TestD1();
  clock = new FixedClock();
  sites = new FakeSites();
  strapi = new FakeStrapi([]);
  sleeps = [];
  deps = {
    store: new CanonicalStore(db.asD1()),
    archive: new MemoryRawArchive(),
    fetch: routedFetch(strapi, sites),
    clock,
    environment: "test",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
});

const runLibrary = () => runIngestion(deps, { sourceIds: ["library-announcements"], trigger: "test" });
const runLc = () => runIngestion(deps, { sourceIds: ["lc-announcements"], trigger: "test" });
const entity = (key: string) =>
  db.rows<{ version: number; status: string; verified_at: string; payload_json: string; source_url: string }>(
    `SELECT version, status, verified_at, payload_json, source_url FROM entities WHERE stable_key = '${key}'`,
  )[0];

describe("library.ntpu.edu.tw", () => {
  it("walks every list page, skips external links, and stores full text and attachments", async () => {
    sites.library = Array.from({ length: 23 }, (_, i) => libraryNews(i + 1));
    sites.library[4] = libraryNews(5, { external: true });
    sites.library[0] = libraryNews(1, {
      attachments: [{ name: "申請表.pdf", href: "/download/abc123;jsessionid=XYZ" }],
    });
    const summary = await runLibrary();
    expect(summary).toMatchObject({ status: "success", fetched: 3 + 22, published: 22, skipped: 1, failed: 0 });
    expect(sites.requests.filter((r) => r.startsWith("POST"))).toHaveLength(3);
    expect(sites.requests.every((r) => !r.includes("jsessionid"))).toBe(true);
    expect(sleeps.every((ms) => ms === 1000)).toBe(true);
    expect(sleeps).toHaveLength(summary.fetched - 1);

    const first = entity(`library:${libraryId(1)}`)!;
    expect(JSON.parse(first.payload_json)).toMatchObject({
      title: "圖書館公告 1",
      bodyText: "第 1 則圖書館公告內文。",
      publishedAt: "2026-09-01T16:00:00.000Z",
      attachments: [{ name: "申請表.pdf", url: "https://library.ntpu.edu.tw/download/abc123" }],
    });
    expect(first.source_url).toBe(
      `https://library.ntpu.edu.tw/singlehtml/3c152b26c59f4dba96939df64e2edd2f?cntId=${libraryId(1)}`,
    );
  });

  it("does not re-fetch unchanged details the next day, but re-fetches edited ones and re-verifies weekly", async () => {
    sites.library = [libraryNews(1), libraryNews(2)];
    await runLibrary();
    const verified = entity(`library:${libraryId(1)}`)!.verified_at;

    clock.advance(86_400);
    sites.requests = [];
    const quiet = await runLibrary();
    expect(quiet).toMatchObject({ status: "success", fetched: 1, published: 0 });
    expect(entity(`library:${libraryId(1)}`)!.verified_at).toBe(verified);

    sites.library[1] = libraryNews(2, { title: "圖書館公告 2（更正）" });
    clock.advance(86_400);
    const edited = await runLibrary();
    expect(edited).toMatchObject({ fetched: 2, published: 1 });
    expect(entity(`library:${libraryId(2)}`)!.version).toBe(2);
    expect(db.count("record_versions")).toBe(1);

    clock.advance(7 * 86_400 + 3600);
    const weekly = await runLibrary();
    expect(weekly).toMatchObject({ fetched: 3, published: 0, unchanged: 2 });
  });

  it("marks an announcement inactive only after it is missing from three complete list walks", async () => {
    sites.library = [libraryNews(1), libraryNews(2)];
    await runLibrary();
    sites.library = [libraryNews(1)];
    for (let i = 0; i < 3; i++) {
      clock.advance(86_400);
      await runLibrary();
      expect(entity(`library:${libraryId(1)}`)!.status).toBe("active");
    }
    expect(entity(`library:${libraryId(2)}`)!.status).toBe("inactive");
  });

  it("a failed detail page makes the run partial but keeps the others", async () => {
    sites.library = [libraryNews(1), libraryNews(2)];
    const original = sites.fetch;
    sites.fetch = async (r) => (r.url.includes(libraryId(2)) ? new Response("err", { status: 500 }) : original(r));
    deps.fetch = routedFetch(strapi, sites);
    const summary = await runLibrary();
    expect(summary).toMatchObject({ status: "partial", published: 1 });
    expect(summary.errors[0]).toMatchObject({ code: "FETCH_HTTP_ERROR" });
  });

  it("a changed list layout fails closed as parser drift", async () => {
    sites.library = [libraryNews(1)];
    await runLibrary();
    deps.fetch = async () =>
      new Response("<html><body>維護中</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    clock.advance(86_400);
    const summary = await runLibrary();
    expect(summary.status).toBe("failed");
    expect(summary.errors[0]!.code).toBe("PARSER_DRIFT");
    expect(entity(`library:${libraryId(1)}`)!.status).toBe("active");
  });
});

describe("lc.ntpu.edu.tw", () => {
  // 個資過濾預設關閉；這裡開啟來驗證過濾開啟時的行為。
  const lcAdapter = getSource("lc-announcements")!.adapter;
  beforeEach(() => {
    if (lcAdapter.kind === "html-news") lcAdapter.personalDataGuard = "all";
  });
  afterEach(() => {
    if (lcAdapter.kind === "html-news") lcAdapter.personalDataGuard = "off";
  });

  it("backfills a long archive over several runs and is picked again before other offices", async () => {
    sites.lc = Array.from({ length: 130 }, (_, i) => lcNews(i + 1));
    const first = await runLc();
    expect(first).toMatchObject({ status: "partial", published: 60, deferred: 70, failed: 0 });
    expect(db.rows("SELECT pending_count FROM sources")).toEqual([{ pending_count: 70 }]);

    // 其他來源都已跑過；語言中心還有內文沒抓完，15 分鐘後優先接著抓。
    for (const s of ["ord-announcements", "library-announcements"]) {
      await runIngestion(deps, { sourceIds: [s], trigger: "test" });
    }
    clock.advance(16 * 60);
    expect((await pickDueSource(deps.store, clock.nowIso()))!.id).not.toBe("lc-announcements"); // 從沒跑過的優先
    for (const s of (await import("../../src/ingestion/source-registry")).enabledSources()) {
      if (!["lc-announcements", "ord-announcements", "library-announcements"].includes(s.id)) {
        await deps.store.ensureSource(s, clock.nowIso());
        await deps.store.markStarted(s.id, clock.nowIso());
      }
    }
    clock.advance(16 * 60);
    expect((await pickDueSource(deps.store, clock.nowIso()))!.id).toBe("lc-announcements");

    const second = await runLc();
    expect(second).toMatchObject({ published: 60, deferred: 10 });
    clock.advance(16 * 60);
    const third = await runLc();
    expect(third).toMatchObject({ status: "success", published: 10, deferred: 0 });
    expect(db.rows("SELECT COUNT(*) AS n FROM entities WHERE source_unit = 'lc'")).toEqual([{ n: 130 }]);
    expect(db.rows("SELECT pending_count FROM sources WHERE id = 'lc-announcements'")).toEqual([{ pending_count: 0 }]);
  });

  it("does not republish student name lists; keeps them traceable in quarantine without re-fetching daily", async () => {
    sites.lc = [
      lcNews(1),
      lcNews(2, { title: "EMI 教學助理培訓合格名單", body: "<table><tr><td>高O琁</td><td>王O明</td><td>李O華</td></tr></table>" }),
    ];
    const summary = await runLc();
    expect(summary).toMatchObject({ status: "success", published: 1, quarantined: 1, failed: 0 });
    const [q] = db.rows<{ stable_key: string; reason: string }>("SELECT stable_key, reason FROM quarantined_records");
    expect(q!.stable_key).toBe(lcId(2));
    expect(q!.reason).toMatch(/^PERSONAL_DATA/);
    expect(db.rows("SELECT COUNT(*) AS n FROM entities WHERE search_text LIKE '%O琁%'")).toEqual([{ n: 0 }]);

    clock.advance(86_400);
    sites.requests = [];
    const next = await runLc();
    expect(next).toMatchObject({ status: "success", fetched: 1 });
    expect(db.count("quarantined_records")).toBe(1);
  });

  it("an announcement that later turns out to list students is withheld, not served", async () => {
    sites.lc = [lcNews(1), lcNews(2, { title: "獎勵結果公告" })];
    await runLc();
    expect(entity(`lc:${lcId(2)}`)!.status).toBe("active");

    // 過濾規則更新或官網補上名單後，重新驗證時被擋下：狀態改為 withheld，查不到。
    sites.lc[1] = lcNews(2, { title: "獎勵結果公告", body: "<p>王〇明 李〇華 陳〇安</p>" });
    clock.advance(3600);
    const summary = await runIngestion(deps, {
      sourceIds: ["lc-announcements"],
      trigger: "test",
      reverifyBefore: clock.nowIso(),
    });
    expect(summary).toMatchObject({ fetched: 3, quarantined: 1 });
    expect(entity(`lc:${lcId(2)}`)!.status).toBe("withheld");
    expect(entity(`lc:${lcId(1)}`)!.status).toBe("active");

    // 之後每天走列表時不會又被標回 active。
    clock.advance(86_400);
    await runLc();
    expect(entity(`lc:${lcId(2)}`)!.status).toBe("withheld");
    const { ReadRepository } = await import("../../src/db/read-repository");
    const repo = new ReadRepository(db.asD1());
    expect(await repo.getAnnouncementRows(lcId(2), ["lc"])).toEqual([]);
    expect((await repo.searchAnnouncements({ keywords: ["獎勵"], limit: 10 })).length).toBe(0);
  });

  it("a forced re-verification finishes in batches without picking the same records again", async () => {
    sites.lc = Array.from({ length: 70 }, (_, i) => lcNews(i + 1));
    sites.lc[3] = lcNews(4, { body: "<p>王〇明 李〇華 陳〇安</p>" });
    await runLc();
    await runLc();
    clock.advance(3600);
    const cutoff = clock.nowIso();
    const deferred: number[] = [];
    for (let i = 0; i < 4; i++) {
      clock.advance(60);
      const r = await runIngestion(deps, { sourceIds: ["lc-announcements"], trigger: "test", reverifyBefore: cutoff });
      deferred.push(r.deferred);
      if (r.deferred === 0) break;
    }
    // 69 筆已收錄 + 1 筆在隔離區：第一次 60 筆，第二次剩下的 10 筆，之後不再重抓。
    expect(deferred).toEqual([10, 0]);
    sites.requests = [];
    clock.advance(60);
    const again = await runIngestion(deps, { sourceIds: ["lc-announcements"], trigger: "test", reverifyBefore: cutoff });
    expect(again).toMatchObject({ status: "success", deferred: 0 });
    expect(sites.requests.some((r) => r.includes("news_in.jsp"))).toBe(false);
  });

  it("dates are Taiwan calendar dates", async () => {
    sites.lc = [lcNews(1, { date: "2026-10-03" })];
    await runLc();
    expect(JSON.parse(entity(`lc:${lcId(1)}`)!.payload_json).publishedAt).toBe("2026-10-02T16:00:00.000Z");
  });
});

describe("HTML source URL policy", () => {
  const lc = getSource("lc-announcements")!;
  const ok = async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });

  it.each([
    [{ np_no: "../admin" }],
    [{ np_no: "NP123" }],
    [{ np_no: lcId(1), redirect: "https://evil.example" }],
  ])("rejects detail query %j", async (query) => {
    await expect(
      fetchSource(lc, { target: "x", path: "/web/news/news_in.jsp", method: "GET", query }, { fetch: ok, clock }),
    ).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
  });

  it("rejects other paths on the same host and methods the source does not allow", async () => {
    await expect(
      fetchSource(lc, { target: "x", path: "/web/download/download.jsp", method: "GET" }, { fetch: ok, clock }),
    ).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    const ord = getSource("ord-announcements")!;
    await expect(
      fetchSource(ord, { target: "x", path: "/strapi", method: "GET" }, { fetch: ok, clock }),
    ).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
  });
});

describe("president and vice-president pages", () => {
  it("stores only the configured pages, without editor e-mail addresses", async () => {
    strapi.sections = {
      "/president": section(1, "/president", { title: "校長" }),
      "/educational-philosophy": section(2, "/educational-philosophy", { title: "治校理念" }),
    };
    const summary = await runIngestion(deps, { sourceIds: ["president-pages"], trigger: "test" });
    expect(summary).toMatchObject({ status: "success", published: 2 });
    const rows = db.rows<{ stable_key: string; payload_json: string; source_url: string }>(
      "SELECT stable_key, payload_json, source_url FROM entities ORDER BY stable_key",
    );
    expect(rows.map((r) => r.source_url).sort()).toEqual([
      "https://new.ntpu.edu.tw/educational-philosophy",
      "https://new.ntpu.edu.tw/president",
    ]);
    expect(rows.every((r) => !r.payload_json.includes("gm.ntpu.edu.tw"))).toBe(true);
    expect(strapi.bodies.at(-1)).not.toContain("editors");
  });

  it("zero pages while pages exist is drift, not disappearance", async () => {
    await runIngestion(deps, { sourceIds: ["vice-president-academic-pages"], trigger: "test" });
    strapi.sections = {};
    clock.advance(86_400);
    const summary = await runIngestion(deps, { sourceIds: ["vice-president-academic-pages"], trigger: "test" });
    expect(summary.errors[0]!.code).toBe("PARSER_DRIFT");
    expect(db.rows("SELECT missing_runs FROM entities")).toEqual([{ missing_runs: 0 }]);
  });
});
