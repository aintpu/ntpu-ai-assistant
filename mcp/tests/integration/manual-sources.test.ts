import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import { MISSING_RUNS_THRESHOLD, runIngestion, type IngestionDeps } from "../../src/ingestion/run-ingestion";
import { createHandler, type McpEnv } from "../../src/mcp/index";
import { TestD1 } from "../helpers/d1-shim";
import { FixedClock, MemoryRawArchive } from "../helpers/fixtures";
import { catalogJson, faqMd, MemoryManualInbox, regulationsMd } from "../helpers/manual-fixtures";

const OSA_FILE = "crawler_data/osa_regulations.md";
const CATALOG = "derived/regulation-catalog.json";
const ORD_FAQ = "crawler_data/ord_faq.md";
const HR_FAQ = "crawler_data/hr_content.md";

let db: TestD1;
let clock: FixedClock;
let inbox: MemoryManualInbox;
let deps: IngestionDeps;

beforeEach(() => {
  db = new TestD1();
  clock = new FixedClock();
  inbox = new MemoryManualInbox();
  deps = {
    store: new CanonicalStore(db.asD1()),
    archive: new MemoryRawArchive(),
    fetch: async () => {
      throw new Error("manual sources must never use the network");
    },
    clock,
    environment: "test",
    manual: inbox,
  };
  inbox.set(
    OSA_FILE,
    regulationsMd([
      { title: "國立臺北大學學生請假規定", body: "第一條 學生請假依本規定辦理。\n第二條 病假須附證明。" },
      { title: "國立臺北大學學生獎懲辦法", body: "第一條 為鼓勵學生向善，特訂定本辦法。" },
      // 同一檔案裡標題重複（真實資料有）：兩份都要保留，編號不同。
      { title: "國立臺北大學學生獎懲辦法", body: "（附件）獎懲建議表" },
    ]),
  );
  inbox.set(
    CATALOG,
    catalogJson([
      // 與全文配對：標題只差空白與副檔名，補上官方連結與標籤。
      { owner: "學生事務處", title: "國立臺北大學 學生請假規定.pdf", fileUrl: "https://cms-carrier.ntpu.edu.tw/uploads/leave.pdf", tags: ["法規", "請假"] },
      // 全文沒有的學務處法規：只收目錄。
      { owner: "學生事務處", title: "國立臺北大學學生宿舍管理要點", fileUrl: "https://cms-carrier.ntpu.edu.tw/uploads/dorm.pdf" },
      // 其他單位：由 regulation-catalog 收錄。
      { owner: "法律學院", title: "法律學院院務會議設置辦法", catalog: "academic" },
      { owner: "秘書室", title: "秘書室公文處理要點" },
      // 沒有任何連結（例如「尚無可用法規資料」）：不收錄。
      { owner: "海山學研究中心", title: "（尚無可用法規資料）", fileUrl: null, catalog: "academic" },
    ]),
  );
  inbox.set(
    ORD_FAQ,
    faqMd([
      { q: "研發處的電話是多少？", a: "02-8674-1111 分機 66001。", id: "ORD-HQ-002", url: "https://new.ntpu.edu.tw/ord" },
      { q: "國科會計畫怎麼申請？", a: "請至國科會網站線上申請，校內截止日為公告日期。", id: "ORD-RM-010", topic: "研究計畫" },
    ]),
  );
  // 人事室 FAQ 沒有編號：用問題產生穩定編號。
  inbox.set(HR_FAQ, faqMd([{ q: "行政人員一年有多少天特休？", a: "依任用身分與年資而定，請洽人事室。" }]));
});

const run = (ids: string[]) => runIngestion(deps, { sourceIds: ids, trigger: "test" });
const regulations = () =>
  db.rows<{ stable_key: string; version: number; status: string; source_url: string; payload_json: string }>(
    `SELECT stable_key, version, status, source_url, payload_json FROM entities WHERE entity_type='regulation' ORDER BY stable_key`,
  );
const payload = (row: { payload_json: string }) => JSON.parse(row.payload_json);

describe("manual regulations", () => {
  it("joins the catalog by normalized title, keeps duplicate titles, and adds catalog-only regulations", async () => {
    const summary = await run(["osa-regulations"]);
    expect(summary).toMatchObject({ status: "success", quarantined: 0, failed: 0 });
    const rows = regulations().map(payload);
    expect(rows).toHaveLength(4);
    const leave = rows.find((r) => r.title === "國立臺北大學學生請假規定");
    expect(leave).toMatchObject({
      unit: "osa",
      owner: "學生事務處",
      hasFullText: true,
      fileUrl: "https://cms-carrier.ntpu.edu.tw/uploads/leave.pdf",
      sourceUrl: "https://cms-carrier.ntpu.edu.tw/uploads/leave.pdf",
      tags: ["法規", "請假"],
    });
    expect(leave.bodyText).toContain("第二條 病假須附證明。");
    expect(leave.bodyText).not.toContain("### Page");
    const rewards = rows.filter((r) => r.title === "國立臺北大學學生獎懲辦法");
    expect(rewards).toHaveLength(2);
    expect(new Set(rewards.map((r) => r.id)).size).toBe(2);
    // 配對不到官方連結：不給網址（不指向 repo 等非官方網址），追溯靠 sourceFile。
    expect(rewards[0].sourceUrl).toBeNull();
    expect(rewards[0].sourceFile).toBe(OSA_FILE);
    expect(db.rows<{ u: string }>(`SELECT source_url u FROM entities WHERE stable_key = 'osa:${rewards[0].id}'`)[0]!.u).toBe("");
    expect(rows.find((r) => r.title === "國立臺北大學學生宿舍管理要點")).toMatchObject({ hasFullText: false, bodyText: "" });
  });

  it("collects the other units' catalog rows under their own unit codes and skips rows without links", async () => {
    const summary = await run(["regulation-catalog"]);
    expect(summary).toMatchObject({ status: "success", skipped: 3 }); // 學務處 2 列（由 osa 收錄）＋ 沒有連結的 1 列
    const rows = regulations();
    expect(rows.map((r) => r.stable_key.split(":")[0]).sort()).toEqual(["academic", "os"]);
    expect(rows.map(payload).map((r) => r.owner).sort()).toEqual(["法律學院", "秘書室"]);
  });

  it("re-running unchanged files creates no new versions; an edit keeps the old version", async () => {
    await run(["osa-regulations"]);
    clock.advance(24 * 3600);
    const second = await run(["osa-regulations"]);
    expect(second).toMatchObject({ published: 0, unchanged: 4 });
    expect(db.count("record_versions")).toBe(0);

    inbox.set(OSA_FILE, regulationsMd([{ title: "國立臺北大學學生請假規定", body: "第一條 修正後的條文。" }, { title: "國立臺北大學學生獎懲辦法", body: "第一條 為鼓勵學生向善，特訂定本辦法。" }, { title: "國立臺北大學學生獎懲辦法", body: "（附件）獎懲建議表" }]));
    clock.advance(24 * 3600);
    const third = await run(["osa-regulations"]);
    expect(third).toMatchObject({ published: 1, unchanged: 3 });
    const leave = regulations().find((r) => payload(r).title === "國立臺北大學學生請假規定")!;
    expect(leave.version).toBe(2);
    expect(payload(leave).bodyText).toBe("第一條 修正後的條文。");
    expect(db.count("record_versions")).toBe(1);
  });

  it("a regulation removed from the file becomes inactive after consecutive complete runs, never deleted", async () => {
    await run(["osa-regulations"]);
    inbox.set(OSA_FILE, regulationsMd([{ title: "國立臺北大學學生請假規定", body: "第一條 學生請假依本規定辦理。\n第二條 病假須附證明。" }]));
    for (let i = 0; i < MISSING_RUNS_THRESHOLD; i++) {
      clock.advance(24 * 3600);
      await run(["osa-regulations"]);
    }
    const statuses = regulations().map((r) => [payload(r).title, r.status]);
    expect(statuses.filter(([, s]) => s === "inactive")).toHaveLength(2);
    expect(regulations()).toHaveLength(4);
  });

  it("a missing upload fails the source without touching existing data", async () => {
    await run(["osa-regulations"]);
    inbox.files.delete(OSA_FILE);
    clock.advance(3600);
    const summary = await run(["osa-regulations"]);
    // 只讀到彙整表、全文檔讀不到：整個來源判定失敗，既有資料不動。
    expect(summary.status).toBe("failed");
    expect(summary.errors[0]).toMatchObject({ code: "FETCH_HTTP_ERROR", target: OSA_FILE });
    expect(regulations().every((r) => r.status === "active")).toBe(true);
  });
});

describe("manual FAQs", () => {
  it("a missing office file does not block the other offices, and does not deactivate that office's FAQs", async () => {
    await run(["office-faqs"]); // 只有研發處與人事室的檔案（其他尚未上傳）
    const before = db.rows<{ stable_key: string; status: string }>(`SELECT stable_key, status FROM entities WHERE entity_type='faq'`);
    expect(before.length).toBe(3);
    // 研發處的檔案之後也讀不到：連續多次執行都不能把研發處的 FAQ 標為 inactive。
    inbox.files.delete(ORD_FAQ);
    for (let i = 0; i < MISSING_RUNS_THRESHOLD + 1; i++) {
      clock.advance(24 * 3600);
      const s = await run(["office-faqs"]);
      expect(s.status).toBe("partial");
    }
    const after = db.rows<{ stable_key: string; status: string }>(`SELECT stable_key, status FROM entities WHERE entity_type='faq'`);
    expect(after.every((r) => r.status === "active")).toBe(true);
  });

  it("stores each office's questions under its own unit, with stable generated ids when the file has none", async () => {
    inbox.set("crawler_data/oga_content.md", faqMd([{ q: "設備故障怎麼報修？", a: "請使用線上報修系統。", id: "GA-OPS-001" }]));
    const missing = await run(["office-faqs"]);
    // 其他 13 個處室的檔案還沒上傳：來源不完整，已上傳的照樣寫入。
    expect(missing.status).toBe("partial");
    const keys = db.rows<{ stable_key: string }>(`SELECT stable_key FROM entities WHERE entity_type='faq' ORDER BY stable_key`).map((r) => r.stable_key);
    expect(keys).toContain("ord:ORD-HQ-002");
    expect(keys).toContain("oga:GA-OPS-001");
    const hr = keys.find((k) => k.startsWith("op:"))!;
    expect(hr).toMatch(/^op:op-q-[0-9a-f]{12}$/);
  });
});

describe("MCP tools for regulations and FAQs", () => {
  let handler: ReturnType<typeof createHandler>;
  let env: McpEnv;
  let id = 1;
  const call = async (name: string, args: unknown) => {
    const res = await handler.fetch(
      new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
      }),
      env,
    );
    return ((await res.json()) as any).result;
  };

  beforeEach(async () => {
    await run(["osa-regulations", "regulation-catalog", "office-faqs"]);
    handler = createHandler(clock);
    env = { DB: db.asD1(), ENVIRONMENT: "test" };
  });

  it("search_regulations finds full text by keyword and marks provenance as manually verified", async () => {
    const out = (await call("search_regulations", { keyword: "病假" })).structuredContent;
    expect(out.count).toBe(1);
    expect(out.items[0]).toMatchObject({ title: "國立臺北大學學生請假規定", hasFullText: true, unit: "osa" });
    expect(out.items[0].provenance).toMatchObject({
      sourceType: "manual_verified",
      trustLevel: "verified",
      sourceUrl: "https://cms-carrier.ntpu.edu.tw/uploads/leave.pdf",
    });
  });

  it("a regulation without an official link has no URL, only a plain-text source name", async () => {
    const out = (await call("search_regulations", { keyword: "獎懲" })).structuredContent;
    expect(out.items).toHaveLength(2);
    for (const item of out.items) {
      expect(item.provenance.sourceUrl).toBeNull();
      expect(item.sourceName).toBe("學生事務處法規（人工整理資料）");
    }
    const linked = (await call("search_regulations", { keyword: "病假" })).structuredContent.items[0];
    expect(linked.sourceName).toBe("學生事務處法規（人工整理資料）");
    expect(linked.provenance.sourceUrl).toBe("https://cms-carrier.ntpu.edu.tw/uploads/leave.pdf");
    const catalogOnly = (await call("search_regulations", { keyword: "宿舍" })).structuredContent.items[0];
    expect(catalogOnly.sourceName).toBe("學生事務處法規彙整表（人工整理資料）");
  });

  it("search_regulations filters by unit, including catalog-only units", async () => {
    const out = (await call("search_regulations", { unit: "academic" })).structuredContent;
    expect(out.items.map((i: any) => i.owner)).toEqual(["法律學院"]);
    expect(out.items[0]).toMatchObject({ hasFullText: false });
  });

  it("get_regulation returns the full text by id without knowing the unit", async () => {
    const found = (await call("search_regulations", { keyword: "請假" })).structuredContent.items[0];
    const out = (await call("get_regulation", { id: found.id })).structuredContent;
    expect(out.found).toBe(true);
    expect(out.regulation.bodyText).toContain("第一條");
    expect((await call("get_regulation", { id: "0".repeat(24) })).structuredContent.found).toBe(false);
  });

  it("search_faqs and get_faq return answers with their fields and source", async () => {
    const out = (await call("search_faqs", { keyword: "國科會" })).structuredContent;
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ id: "ORD-RM-010", unit: "ord", topic: "研究計畫", sourceDate: "2026-09-01" });
    const faq = (await call("get_faq", { id: "ORD-RM-010" })).structuredContent;
    expect(faq.faq).toMatchObject({ answer: "請至國科會網站線上申請，校內截止日為公告日期。", status: "active" });
    expect(faq.faq.details).toContain("聯絡窗口：承辦人，分機 1234");
    expect(faq.faq.provenance.trustLevel).toBe("verified");
    expect(faq.faq.sourceName).toBe("研究發展處常見問答（人工整理資料）");
  });

  it("rejects malformed ids instead of querying", async () => {
    expect((await call("get_faq", { id: "x%' OR 1=1 --" })).isError).toBe(true);
    expect((await call("get_regulation", { id: "not-hex" })).isError).toBe(true);
  });
});
