import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import { runIngestion } from "../../src/ingestion/run-ingestion";
import { createHandler, type McpEnv } from "../../src/mcp/index";
import { matchScore } from "../../src/mcp/official-service";
import type { Official } from "../../src/shared/schemas";
import { TestD1 } from "../helpers/d1-shim";
import { DEFAULT_SECTIONS, FakeStrapi, FixedClock, MemoryRawArchive, routedFetch, section } from "../helpers/fixtures";
import { FakeSites } from "../helpers/html-fixtures";
import { MemoryManualInbox, seedManualInbox } from "../helpers/manual-fixtures";

let db: TestD1;
let clock: FixedClock;
let env: McpEnv;
let sections: Record<string, unknown>;

function officialSections(): Record<string, unknown> {
  return {
    ...DEFAULT_SECTIONS,
    "/president": section(1, "/president", {
      title: "校長",
      content: "<p>林道通 校長</p><p>國立臺北大學 校長 2025至今</p>",
      content_en: "<p>DR. DALTON DAW-TUNG, LIN</p>",
    }),
    "/vice-president-academic": section(3, "/vice-president-academic", {
      title: "學術副校長",
      content: "<p>學術副校長 陳宥杉</p>",
      content_en: "<p>DR.YU-SHAN CHEN</p>",
    }),
    // 英文頁改版、已沒有原本的英文姓名 → 英文欄留空
    "/oaa/director": section(10, "/oaa/director", { title: "教務長", content: "<p>教務長 陳婉琪</p>", content_en: "<p>待補</p>" }),
    "/edusp/director": section(11, "/edusp/director", { title: "主任", content: "<p>主任 陳婉琪</p>" }),
    // 換人了：對照表的姓名已不在頁面上 → 不提供
    "/osa/director": section(12, "/osa/director", { title: "學務長", content: "<p>學務長 某某某</p>" }),
    "/oia/director": section(13, "/oia/director", { title: "Dean", content: "<p>國際長</p>", content_en: "<p>Thijs A. Velema</p>" }),
  };
}

async function ingest() {
  await runIngestion(
    {
      store: new CanonicalStore(db.asD1()),
      archive: new MemoryRawArchive(),
      fetch: routedFetch(new FakeStrapi([], {}, sections), new FakeSites([], [])),
      clock,
      environment: "test",
      sleep: async () => {},
      manual: seedManualInbox(new MemoryManualInbox()),
    },
    { trigger: "test" },
  );
}

beforeEach(async () => {
  db = new TestD1();
  clock = new FixedClock();
  sections = officialSections();
  await ingest();
  env = { DB: db.asD1(), ENVIRONMENT: "test" };
});

async function officials(args: Record<string, unknown>) {
  const res = await createHandler(clock).fetch(
    new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_current_officials", arguments: args },
      }),
    }),
    env,
  );
  const body = (await res.json()) as any;
  return body.result.structuredContent as { items: any[]; count: number; noResult: boolean };
}

describe("get_current_officials", () => {
  it("only serves officials whose name is still on the official page", async () => {
    const all = await officials({});
    const names = all.items.map((o) => `${o.title}:${o.name ?? o.nameEn}`).sort();
    expect(names).toEqual(["國際長:Thijs A. Velema", "學術副校長:陳宥杉", "教務長:陳婉琪", "校長:林道通", "高教深耕計畫辦公室主任:陳婉琪"]);
    const president = all.items.find((o) => o.title === "校長");
    expect(president).toMatchObject({
      nameEn: "Dalton Daw-Tung Lin",
      nameEnOfficial: "DR. DALTON DAW-TUNG, LIN",
      term: "2025至今",
      sourceUrl: "https://new.ntpu.edu.tw/president",
      pageUpdatedAt: "2026-09-04T03:00:00.000Z",
    });
    expect(president.provenance.verifiedAt).toBeTruthy();
  });

  it("leaves the English name empty when the English page no longer shows it", async () => {
    const [dean] = (await officials({ keyword: "教務長" })).items;
    expect(dean).toMatchObject({ name: "陳婉琪", nameEn: null, nameEnOfficial: null });
    expect(dean.note).toContain("英文姓名留空");
  });

  it("finds people by Chinese name, English name in any order, or title", async () => {
    expect((await officials({ keyword: "誰是陳宥杉" })).items.map((o) => o.title)).toEqual(["學術副校長"]);
    expect((await officials({ keyword: "Lin Daw-Tung" })).items.map((o) => o.name)).toEqual(["林道通"]);
    expect((await officials({ keyword: "Velema" })).items.map((o) => o.title)).toEqual(["國際長"]);
    expect((await officials({ keyword: "陳婉琪" })).count).toBe(2);
    // 「學術副校長」不會連帶列出校長
    expect((await officials({ keyword: "學術副校長" })).items.map((o) => o.name)).toEqual(["陳宥杉"]);
    expect(
      (await officials({ keyword: "Who is the vice president for academic affairs at NTPU?" })).items.map((o) => o.name),
    ).toEqual(["陳宥杉"]);
    expect((await officials({ keyword: "Who is the president of NTPU?" })).items.map((o) => o.name)).toEqual(["林道通"]);
    expect((await officials({ keyword: "宋明翰" })).noResult).toBe(true);
  });

  it("stops serving an official once the page no longer names them", async () => {
    sections["/president"] = section(1, "/president", { title: "校長", content: "<p>新任校長 某某某</p>" });
    clock.advance(3600);
    await ingest();
    expect((await officials({ keyword: "林道通" })).noResult).toBe(true);
  });
});

describe("matchScore", () => {
  const base: Official = {
    id: "0".repeat(24),
    unit: "president",
    title: "校長",
    name: "林道通",
    nameEn: "Dalton Daw-Tung Lin",
    nameEnOfficial: "DR. DALTON DAW-TUNG, LIN",
    titleEnSearch: ["president"],
    term: null,
    termSource: null,
    note: null,
    path: "/president",
    pageTitle: "",
    pageUpdatedAt: "2026-09-04T03:00:00.000Z",
    sourceUrl: "https://new.ntpu.edu.tw/president",
  };
  it("does not match unrelated words", () => {
    expect(matchScore(base, "library hours")).toBe(0);
    expect(matchScore(base, "教務長")).toBe(0);
  });
});
