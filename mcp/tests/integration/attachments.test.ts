import { beforeAll, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import { runIngestion } from "../../src/ingestion/run-ingestion";
import { createHandler, type McpEnv } from "../../src/mcp/index";
import { TestD1 } from "../helpers/d1-shim";
import { makeOdt, makePdf } from "../helpers/attachment-fixtures";
import { FakeStrapi, FixedClock, MemoryRawArchive, publication } from "../helpers/fixtures";

const FILES: Record<string, { bytes: Uint8Array; type: string }> = {
  "/uploads/brochure_1.pdf": { bytes: makePdf("Master program exam subjects: Computer Science, MIS"), type: "application/pdf" },
  "/uploads/scan_2.pdf": { bytes: makePdf(""), type: "application/pdf" },
  "/uploads/list_3.odt": {
    bytes: makeOdt(["115學年度獎學金獲獎名單", "法律學系 王O明", "經濟學系 陳O華", "財政學系 林O安"]),
    type: "application/vnd.oasis.opendocument.text",
  },
  "/uploads/form_4.odt": { bytes: makeOdt(["申請表填寫說明", "請於期限內送交研發處"]), type: "application/vnd.oasis.opendocument.text" },
  "/uploads/poster_5.png": { bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]), type: "image/png" },
  "/uploads/broken_6.pdf": { bytes: new TextEncoder().encode("not a pdf"), type: "application/pdf" },
};

const attachmentPublication = publication(1, {
  title: "115學年度碩士班招生簡章與相關表單",
  files: Object.keys(FILES).map((path) => ({ name: path.split("/").pop()!, url: path })),
});

let db: TestD1;
let deps: Parameters<typeof runIngestion>[0];
let fetched: string[];
let ocrCalls: number;

beforeAll(async () => {
  db = new TestD1();
  const strapi = new FakeStrapi([], { ord_ntpu: [attachmentPublication] });
  fetched = [];
  ocrCalls = 0;
  deps = {
    store: new CanonicalStore(db.asD1()),
    archive: new MemoryRawArchive(),
    clock: new FixedClock(),
    environment: "test",
    sleep: async () => {},
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "api-carrier.ntpu.edu.tw") return strapi.fetch(request);
      fetched.push(url.pathname);
      const file = FILES[url.pathname];
      return file
        ? new Response(file.bytes, { status: 200, headers: { "content-type": file.type } })
        : new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
    ai: {
      async run() {
        ocrCalls++;
        return { response: "研究倫理講座 海報 報名截止 10月30日" };
      },
    },
  };
  await runIngestion(deps, { sourceIds: ["ord-announcements"], trigger: "test" });
});

describe("announcement attachments", () => {
  it("downloads every attachment of collected announcements and extracts or OCRs its text", async () => {
    const summary = await runIngestion(deps, { sourceIds: ["announcement-attachments"], trigger: "test" });
    expect(summary).toMatchObject({ status: "success", fetched: 6, quarantined: 1 });
    expect(fetched.sort()).toEqual(Object.keys(FILES).sort());
    expect(ocrCalls).toBe(1);
  });

  it("serves extracted text through search_attachments, and never the personal-data list", async () => {
    const handler = createHandler(new FixedClock());
    const env: McpEnv = { DB: db.asD1(), ENVIRONMENT: "test" };
    const call = async (name: string, args: unknown) => {
      const res = await handler.fetch(
        new Request("https://mcp.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
        env,
      );
      return ((await res.json()) as any).result.structuredContent;
    };
    const brochure = await call("search_attachments", { keyword: "MIS" });
    expect(brochure.items.map((i: any) => i.name)).toEqual(["brochure_1.pdf"]);
    expect(brochure.items[0]).toMatchObject({ method: "pdf", extracted: true, announcementTitle: "115學年度碩士班招生簡章與相關表單" });
    expect(brochure.items[0].snippet).toContain("Computer Science");
    const detail = await call("get_attachment", { id: brochure.items[0].id });
    expect(detail.attachment.text).toContain("exam subjects");

    expect((await call("search_attachments", { keyword: "報名截止" })).items[0]).toMatchObject({ name: "poster_5.png", method: "ocr" });
    expect((await call("search_attachments", { keyword: "研發處" })).items[0]).toMatchObject({ name: "form_4.odt", method: "office" });
    // 掃描檔與壞檔：只有檔名與連結，可用檔名找到
    expect((await call("search_attachments", { keyword: "scan_2" })).items[0]).toMatchObject({ extracted: false, note: "scanned" });
    expect((await call("search_attachments", { keyword: "broken_6" })).items[0]).toMatchObject({ extracted: false });
    // 名單：讀取但不公開
    expect((await call("search_attachments", { keyword: "王O明" })).count).toBe(0);
    expect((await call("search_attachments", { keyword: "list_3" })).count).toBe(0);
  });

  it("does not download the same files again", async () => {
    fetched.length = 0;
    const summary = await runIngestion(deps, { sourceIds: ["announcement-attachments"], trigger: "test" });
    expect(fetched).toEqual([]);
    expect(summary).toMatchObject({ status: "success", fetched: 0, deferred: 0 });
  });
});
