import { describe, expect, it } from "vitest";
import { MIN_PAGE_CHARS, strapiSectionsAdapter } from "../../src/ingestion/adapters/strapi-sections";
import { getSource } from "../../src/ingestion/source-registry";
import type { StepContext } from "../../src/ingestion/adapters/types";

const osa = getSource("osa-site-pages")!;
const admission = getSource("admission-site-pages")!;
const body = (rows: unknown[]) => new TextEncoder().encode(JSON.stringify({ data: { sections: rows } }));
const ctx = (active = 0): StepContext => ({
  source: osa,
  nowIso: "2026-10-06T00:00:00.000Z",
  known: async () => new Map(),
  activeCount: async () => active,
});
const long = "<p>" + "學務處服務說明".repeat(20) + "</p>";
const row = (id: number, name: string, content = long, title: string | null = "標題") => ({
  _id: id.toString(16).padStart(24, "0"),
  name,
  title,
  content,
  updatedAt: "2026-09-01T00:00:00.000Z",
});

describe("site pages (strapi sections by prefix)", () => {
  it("registers one prefix source per office, admission under 教務處", () => {
    expect(osa.adapter).toEqual({ kind: "strapi-sections", pathPrefix: "/osa/" });
    expect(admission.sourceUnit).toBe("oaa");
    const [step] = strapiSectionsAdapter.start(osa, "");
    expect(JSON.parse(step!.request.body!).query).toContain('name_contains:"/osa/"');
  });

  it("keeps content pages and skips other prefixes, empty shells, banners and deprecated pages", async () => {
    const [step] = strapiSectionsAdapter.start(osa, "");
    const out = await step!.handle(
      body([
        row(1, "/osa/about"),
        row(2, "/humanities/osa/x"), // name_contains 也會比到中間，前綴不符
        row(3, "/osa/exam", "<p>考試</p>"), // 空殼頁
        row(4, "/osa/home2"),
        row(5, "/osa/apply(deprecated)"),
      ]),
      ctx(),
    );
    expect(out.records.map((r) => r.id)).toEqual([row(1, "")._id]);
    expect(out.skipped).toBe(4);
    expect(out.listComplete).toBe(true);
    expect("考試".length).toBeLessThan(MIN_PAGE_CHARS);
  });

  it("encodes Chinese paths and uses the last path segment when a page has no title", async () => {
    const [step] = strapiSectionsAdapter.start(admission, "");
    const out = await step!.handle(body([row(6, "/admission/碩士班一般入學", long, null)]), { ...ctx(), source: admission });
    const page = out.records[0]!.payload as { title: string; sourceUrl: string; unit: string };
    expect(page.title).toBe("碩士班一般入學");
    expect(page.unit).toBe("oaa");
    expect(page.sourceUrl).toBe(`https://new.ntpu.edu.tw/admission/${encodeURIComponent("碩士班一般入學")}`);
  });

  it("pages through full result pages and refuses to wipe data when the site suddenly returns nothing", async () => {
    const [step] = strapiSectionsAdapter.start(osa, "");
    const full = Array.from({ length: 100 }, (_, i) => row(100 + i, `/osa/p${i}`));
    const out = await step!.handle(body(full), ctx());
    expect(out.listComplete).toBe(false);
    expect(JSON.parse(out.next![0]!.request.body!).query).toContain("start:100");
    await expect(step!.handle(body([]), ctx(5))).rejects.toMatchObject({ code: "PARSER_DRIFT" });
  });

  it("rejects unsafe prefixes", () => {
    const bad = { ...osa, adapter: { kind: "strapi-sections" as const, pathPrefix: '/osa"}){x}/' } };
    expect(() => strapiSectionsAdapter.start(bad, "")).toThrow(/invalid page prefix/);
  });
});
