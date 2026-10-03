import { describe, expect, it } from "vitest";
import { htmlToText } from "../../src/ingestion/html-text";
import { normalizeAnnouncement } from "../../src/ingestion/normalizers/announcement.normalizer";
import { strapiPublicationsParser } from "../../src/ingestion/parsers/strapi-publications.parser";
import { getSource } from "../../src/ingestion/source-registry";
import { contentHash, stableJson } from "../../src/shared/hash";
import { publication, strapiBody } from "../helpers/fixtures";

const ord = getSource("ord-announcements")!;
const bytes = (s: string) => new TextEncoder().encode(s);

describe("htmlToText", () => {
  it("keeps original text, converts blocks to lines and decodes entities", () => {
    expect(htmlToText("<p>第一行&nbsp;&amp;&#x4E2D;</p><div>第二行</div><br>第三行")).toBe("第一行 &中\n第二行\n第三行");
  });

  it("drops script/style content instead of executing or keeping it", () => {
    expect(htmlToText("<p>內容</p><script>alert(1)</script><style>p{}</style>")).toBe("內容");
  });
});

describe("stable hashing", () => {
  it("is independent of key order", async () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(await contentHash({ b: 1, a: 2 })).toBe(await contentHash({ a: 2, b: 1 }));
  });
});

describe("strapi publications parser", () => {
  it("builds a fixed query containing only the site key and page offset", () => {
    const req = strapiPublicationsParser.buildRequest(ord, 2, "2026-10-03T00:00:00.000Z");
    expect(req.path).toBe("/strapi");
    expect(req.body).toContain('sitesApproved_in:\\"ord_ntpu\\"');
    expect(req.body).toContain("start:200");
  });

  it("rejects GraphQL errors and missing data", () => {
    expect(() => strapiPublicationsParser.parse(bytes('{"errors":[{"message":"x"}]}'))).toThrow(/GraphQL/);
    expect(() => strapiPublicationsParser.parse(bytes('{"data":{}}'))).toThrow(/publications/);
  });

  it("parses the publications array", () => {
    expect(strapiPublicationsParser.parse(bytes(strapiBody([publication(1)])))).toHaveLength(1);
  });
});

describe("announcement normalizer", () => {
  it("produces a deterministic canonical record from source fields only", () => {
    const record = normalizeAnnouncement(
      publication(7, {
        title: "  計畫\n徵件  ",
        files: [
          { name: "B", url: "/uploads/b.pdf" },
          { name: "A", url: "https://cms-carrier.ntpu.edu.tw/uploads/a.pdf" },
          { name: "B", url: "/uploads/b.pdf" },
        ],
      }),
      ord,
    );
    expect(record).toEqual({
      id: "000000000000000000000007",
      unit: "ord",
      title: "計畫 徵件",
      publishedAt: "2026-09-08T00:00:00.000Z",
      bodyText: "第 7 則公告內文。\n請於期限內申請 計畫。",
      attachments: [
        { name: "A", url: "https://cms-carrier.ntpu.edu.tw/uploads/a.pdf" },
        { name: "B", url: "https://cms-carrier.ntpu.edu.tw/uploads/b.pdf" },
      ],
      sourceUrl: "https://new.ntpu.edu.tw/ord/news/000000000000000000000007",
    });
  });

  it("rejects records without a valid id, title or date", () => {
    expect(() => normalizeAnnouncement(publication(1, { _id: "x" }), ord)).toThrow(/VALIDATION|invalid/);
    expect(() => normalizeAnnouncement(publication(1, { title: " " }), ord)).toThrow(/invalid/);
    expect(() => normalizeAnnouncement(publication(1, { publishAt: "soon" }), ord)).toThrow(/invalid/);
  });
});
