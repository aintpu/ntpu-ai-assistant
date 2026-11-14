import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../src/db/canonical-store";
import { runIngestion, type IngestionDeps } from "../../src/ingestion/run-ingestion";
import { gmbaDate } from "../../src/ingestion/adapters/html-sites";
import { TestD1 } from "../helpers/d1-shim";
import { FakeStrapi, FixedClock, MemoryRawArchive, routedFetch } from "../helpers/fixtures";
import { FakeSites } from "../helpers/html-fixtures";

// 2026-11-03 加入的商學院單位：IEMBA、金融科技中心（/fintech/ 子目錄）、GMBA（JSP）、電子商務研究中心（Google 協作平台）、
// 企業永續發展研究中心（靜態頁＋data.json）
let db: TestD1;
let deps: IngestionDeps;

beforeEach(() => {
  db = new TestD1();
  deps = {
    store: new CanonicalStore(db.asD1()),
    archive: new MemoryRawArchive(),
    fetch: routedFetch(new FakeStrapi([]), new FakeSites()),
    clock: new FixedClock(),
    environment: "test",
    sleep: async () => {},
  };
});

const rows = (unit: string) =>
  db.rows<{ entity_type: string; stable_key: string; title: string; source_url: string; payload_json: string }>(
    `SELECT entity_type, stable_key, title, source_url, payload_json FROM entities WHERE source_unit = '${unit}' AND status = 'active' ORDER BY stable_key`,
  );

describe("Department of Economics (Rpage CMS) added 2026-11-13", () => {
  it("dates come from the list; embedded PDFs become attachments", async () => {
    await runIngestion(deps, { sourceIds: ["econ-announcements"], trigger: "test" });
    const news = rows("econ");
    expect(news.map((r) => r.stable_key)).toEqual(["econ:econ0001381", "econ:econ0001384"]);
    const first = news.find((r) => r.stable_key === "econ:econ0001384")!;
    expect(first.source_url).toBe("https://econ.ntpu.edu.tw/p/406-1001-1384.php");
    const payload = JSON.parse(first.payload_json);
    expect(payload.publishedAt).toBe("2026-10-13T16:00:00.000Z");
    expect(payload.attachments.map((a: { url: string }) => a.url)).toContain("https://econ.ntpu.edu.tw/var/file/1/1001/img/1.pdf");
  });

  it("menu pages merge their ajax tab blocks (POST with the page as Referer) into one record", async () => {
    await runIngestion(deps, { sourceIds: ["econ-site-pages"], trigger: "test" });
    const regs = rows("econ").find((r) => r.source_url === "https://econ.ntpu.edu.tw/p/412-1001-111.php")!;
    const body = JSON.parse(regs.payload_json).bodyText as string;
    expect(body).toContain("經濟學系學生事務委員會組織章程");
    expect(body).not.toContain("友善列印");
    expect(rows("econ").length).toBeGreaterThan(30);
  });
});

describe("College of Business units added 2026-11-03", () => {
  it("fintech pages and news live under /fintech/ on the College of Business host", async () => {
    await runIngestion(deps, { sourceIds: ["fintech-site-pages", "fintech-announcements"], trigger: "test" });
    const got = rows("fintech");
    const pages = got.filter((r) => r.entity_type === "page");
    expect(pages).toHaveLength(5);
    expect(pages.every((r) => r.source_url.startsWith("https://www.aacsb.ntpu.edu.tw/fintech/page.php?id="))).toBe(true);
    const news = got.filter((r) => r.entity_type === "announcement");
    expect(news.map((r) => r.source_url)).toContain(`https://www.aacsb.ntpu.edu.tw/fintech/view.php?id=${btoa("3")}`);
  });

  it("IEMBA uses the shared college site", async () => {
    await runIngestion(deps, { sourceIds: ["iemba-site-pages", "iemba-announcements"], trigger: "test" });
    const got = rows("iemba");
    expect(got.filter((r) => r.entity_type === "page")).toHaveLength(7);
    expect(got.some((r) => r.entity_type === "announcement" && r.title.startsWith("學系公告"))).toBe(true);
  });

  it("GMBA news dates come from the np_id timestamp; external list links are skipped", async () => {
    expect(gmbaDate("NP1791882343315")).toBe("2026-10-13");
    expect(gmbaDate("NP12")).toBe("");
    await runIngestion(deps, { sourceIds: ["gmba-announcements", "gmba-site-pages"], trigger: "test" });
    const news = rows("gmba").filter((r) => r.entity_type === "announcement");
    expect(news).toHaveLength(1);
    expect(news[0]!.source_url).toBe("https://www.gmba.ntpu.edu.tw/web/news/news_in.jsp?np_id=NP1791882343315");
    expect(JSON.parse(news[0]!.payload_json).publishedAt).toBe("2026-10-12T16:00:00.000Z");
    expect(rows("gmba").filter((r) => r.entity_type === "page").length).toBeGreaterThan(10);
  });

  it("E-Business Research Center reads Google Sites sections, with a readable home title", async () => {
    await runIngestion(deps, { sourceIds: ["ebrc-site-pages"], trigger: "test" });
    const got = rows("ebrc");
    expect(got).toHaveLength(3);
    expect(got.map((r) => r.title)).toContain("電子商務研究中心簡介");
    expect(JSON.parse(got[0]!.payload_json).bodyText).toContain("電子商務研究中心工作計畫");
  });

  it("Corporate Sustainability: static pages drop header/footer; team and news come from data.json", async () => {
    await runIngestion(deps, { sourceIds: ["ccs-site-pages", "ccs-announcements"], trigger: "test" });
    const got = rows("ccs");
    const pages = got.filter((r) => r.entity_type === "page");
    expect(pages).toHaveLength(21);
    const team = pages.find((r) => r.title === "組織成員名單")!;
    expect(team.source_url).toBe("https://ccs.ntpu.edu.tw/pages/about/organization.html");
    expect(JSON.parse(team.payload_json).bodyText).toContain("王小明 教授；職務：主任；簡介：國立臺北大學金融與合作經營學系特聘教授，研究永續金融。；電子郵件：x@gm.ntpu.edu.tw");
    const other = JSON.parse(pages.find((r) => r.title === "企業永續頁面")!.payload_json).bodyText as string;
    expect(other).not.toContain("頁首");
    expect(other).not.toContain("頁尾");
    const news = got.filter((r) => r.entity_type === "announcement");
    expect(news).toHaveLength(1);
    expect(news[0]!.source_url).toBe("https://ccs.ntpu.edu.tw/pages/news/news-detail.html?id=27");
    expect(JSON.parse(news[0]!.payload_json).bodyText).toContain("第二段");
  });
});

describe("College of Social Sciences departments added 2026-11-14", () => {
  it("social work and criminology walk every news category (with pages), dates and dfile attachments", async () => {
    await runIngestion(deps, { sourceIds: ["sw-announcements", "crm-announcements"], trigger: "test" });
    // 社工系 4 個分類（第一個兩頁）＝5 則；犯罪所 3 個分類（第一個兩頁）＝4 則
    expect(rows("sw").map((r) => r.stable_key)).toHaveLength(5);
    const crm = rows("crm");
    expect(crm).toHaveLength(4);
    const p = JSON.parse(crm[0]!.payload_json);
    expect(p.publishedAt).toBe("2026-09-30T16:00:00.000Z");
    expect(p.attachments[0].url).toContain("task=dfile");
    expect(crm[0]!.source_url).toMatch(/^https:\/\/crm\.ntpu\.edu\.tw\/index\.php\?option=module&lang=cht&task=pageinfo&id=\d+$/);
  });

  it("module-cms pages follow sub-page links one level, without re-fetching configured pages", async () => {
    await runIngestion(deps, { sourceIds: ["sw-site-pages"], trigger: "test" });
    const urls = rows("sw").map((r) => r.source_url);
    expect(urls).toContain("https://www.sw.ntpu.edu.tw/index.php?option=module&lang=cht&task=pageinfo&id=7001");
    expect(urls.filter((u) => u.endsWith("task=showlist&id=21"))).toHaveLength(1);
    expect(urls).toContain("https://www.sw.ntpu.edu.tw/index.php?option=members&lang=cht&task=showlist&id=1");
  });

  it("sociology reads the Nuxt payload: first page of each category, external links skipped, data and member pages", async () => {
    await runIngestion(deps, { sourceIds: ["sociology-announcements", "sociology-site-pages"], trigger: "test" });
    const got = rows("sociology");
    const news = got.filter((r) => r.entity_type === "announcement");
    expect(news).toHaveLength(7);
    expect(news[0]!.source_url).toMatch(/^https:\/\/sociology\.ntpu\.edu\.tw\/news\/TagNews\d00$/);
    const teacher = got.find((r) => r.source_url === "https://sociology.ntpu.edu.tw/teacher?cate=1")!;
    expect(JSON.parse(teacher.payload_json).bodyText).toContain("王社會；教授；學歷：國立臺灣大學社會學博士");
    const thesis = got.find((r) => r.source_url === "https://sociology.ntpu.edu.tw/data/18?cate=88")!;
    expect(JSON.parse(thesis.payload_json).bodyText).toContain("碩士論文一（2026-09-09）");
  });

  it("the aging-and-community center PDF becomes a College of Social Sciences page", async () => {
    await runIngestion(deps, { sourceIds: ["social-sciences-center-docs"], trigger: "test" });
    const [page] = rows("social-sciences");
    expect(page!.title).toBe("社會科學學院高齡與社區研究中心簡介");
    expect(page!.source_url).toBe("https://cms-carrier.ntpu.edu.tw/uploads/_531a116c2f.pdf");
    expect(JSON.parse(page!.payload_json).bodyText).toContain("Aging and Community Research Center");
  });
});
