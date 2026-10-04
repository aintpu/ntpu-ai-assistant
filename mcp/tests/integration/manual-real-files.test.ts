import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import { runIngestion, type IngestionRunSummary } from "../../src/ingestion/run-ingestion";
import { enabledSources } from "../../src/ingestion/source-registry";
import { isManualSource } from "../../src/ingestion/types";
// @ts-expect-error 純 JS 腳本，沒有型別宣告
import { buildRegulationCatalog, CATALOG_PATH, MANUAL_MARKDOWN } from "../../scripts/manual-files.mjs";
import { TestD1 } from "../helpers/d1-shim";
import { FixedClock, MemoryRawArchive } from "../helpers/fixtures";
import { MemoryManualInbox } from "../helpers/manual-fixtures";

/** 用 repo 裡真正的 crawler_data 跑一次完整匯入，確認每個檔案都解析得出來、沒有資料被隔離。 */
const REPO_ROOT = join(__dirname, "..", "..", "..");
const manualSources = enabledSources().filter(isManualSource);

let db: TestD1;
let summary: IngestionRunSummary;
let rerun: IngestionRunSummary;

beforeAll(async () => {
  db = new TestD1();
  const inbox = new MemoryManualInbox();
  for (const file of MANUAL_MARKDOWN as string[]) inbox.set(file, readFileSync(join(REPO_ROOT, file), "utf8"));
  inbox.set(CATALOG_PATH, JSON.stringify(buildRegulationCatalog(REPO_ROOT)));
  const clock = new FixedClock();
  const deps = {
    store: new CanonicalStore(db.asD1()),
    archive: new MemoryRawArchive(),
    fetch: async (): Promise<Response> => {
      throw new Error("manual sources must not use the network");
    },
    clock,
    environment: "test",
    manual: inbox,
  };
  const options = { sourceIds: manualSources.map((s) => s.id), trigger: "test" as const };
  summary = await runIngestion(deps, options);
  clock.advance(24 * 3600);
  rerun = await runIngestion(deps, options);
}, 60_000);

const count = (sql: string) => db.rows<{ n: number }>(sql)[0]!.n;

describe("real crawler_data files", () => {
  it("the upload script uploads exactly the files the registry reads", () => {
    const registered = new Set(manualSources.flatMap((s) => s.entrypoints));
    expect(new Set([...(MANUAL_MARKDOWN as string[]), CATALOG_PATH])).toEqual(registered);
  });

  it("ingests every manual source completely with nothing quarantined", () => {
    expect(summary.errors).toEqual([]);
    expect(summary).toMatchObject({ status: "success", failed: 0, quarantined: 0, deferred: 0 });
    const statuses = db.rows<{ id: string; last_run_status: string }>(
      `SELECT id, last_run_status FROM sources WHERE source_type = 'manual_verified' ORDER BY id`,
    );
    expect(statuses).toHaveLength(manualSources.length);
    expect(statuses.every((s) => s.last_run_status === "success")).toBe(true);
  });

  it("keeps every regulation in the full-text files (duplicate titles get distinct ids)", () => {
    const fullText = { oaa: 156, osa: 170, op: 20, oga: 20, cge: 3 };
    for (const [unit, n] of Object.entries(fullText)) {
      const got = count(
        `SELECT COUNT(*) n FROM entities WHERE entity_type='regulation' AND source_unit='${unit}'
           AND json_extract(payload_json,'$.hasFullText') = 1`,
      );
      expect(got, unit).toBe(n);
    }
  });

  it("keeps every FAQ question", () => {
    expect(count(`SELECT COUNT(*) n FROM entities WHERE entity_type='faq'`)).toBe(1038);
    expect(count(`SELECT COUNT(DISTINCT source_unit) n FROM entities WHERE entity_type='faq'`)).toBe(16);
  });

  it("keeps file names with parentheses and spaces intact (docx and pdf stay separate, links still open)", () => {
    const urls = db
      .rows<{ u: string }>(
        `SELECT json_extract(payload_json,'$.fileUrl') u FROM entities
         WHERE entity_type='regulation' AND json_extract(payload_json,'$.owner') = '華語中心'`,
      )
      .map((r) => r.u);
    expect(urls.some((u) => u.endsWith("(1141022%E4%BF%AE%E6%AD%A3).docx"))).toBe(true);
    expect(urls.some((u) => u.endsWith("(1141022%E4%BF%AE%E6%AD%A3).pdf"))).toBe(true);
    expect(urls.some((u) => u.includes("Application%20Form"))).toBe(true);
  });

  it("FAQ answers are never empty and never swallow the field block", () => {
    const answers = db.rows<{ a: string }>(`SELECT json_extract(payload_json,'$.answer') a FROM entities WHERE entity_type='faq'`);
    expect(answers.every((r) => r.a.trim().length > 0)).toBe(true);
    expect(answers.filter((r) => /^(FAQ 編號|來源網址|來源日期)：/m.test(r.a))).toEqual([]);
    // 回答第一行就是「適用對象：」的那一題（進修推廣部場地借用），回答要完整保留。
    const venue = db.rows<{ a: string }>(
      `SELECT json_extract(payload_json,'$.answer') a FROM entities
       WHERE entity_type='faq' AND json_extract(payload_json,'$.question') = '臺北校區場地怎麼申請借用？'`,
    );
    expect(venue[0]?.a.startsWith("適用對象：")).toBe(true);
  });

  it("re-running the same files the next day changes nothing and creates no versions", () => {
    expect(rerun).toMatchObject({ status: "success", published: 0, failed: 0, quarantined: 0 });
    expect(rerun.unchanged).toBe(summary.published);
    expect(db.count("record_versions")).toBe(0);
  });

  it("only official links are given; records without one have no URL at all (never a repo link)", () => {
    expect(count(`SELECT COUNT(*) n FROM entities WHERE source_url LIKE '%github.com%'`)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM entities WHERE source_url != '' AND source_url NOT LIKE 'http%'`)).toBe(0);
    // 沒有官方連結的只有教務處、學務處配對不到彙整表的法規全文（136 + 146）。
    expect(count(`SELECT COUNT(*) n FROM entities WHERE source_url = ''`)).toBe(282);
    expect(
      count(`SELECT COUNT(*) n FROM entities WHERE source_url = '' AND json_extract(payload_json,'$.sourceUrl') IS NOT NULL`),
    ).toBe(0);
    // FAQ 每一題原檔都有來源網址。
    expect(count(`SELECT COUNT(*) n FROM entities WHERE entity_type='faq' AND source_url = ''`)).toBe(0);
  });
});
