import { describe, expect, it } from "vitest";
import { misPageKey } from "../../src/ingestion/adapters/html-pages";
import { misPostId, misSite, parseMisPage } from "../../src/ingestion/adapters/html-sites";

describe("資管所網站（www.mis.ntpu.edu.tw）", () => {
  it("lists posts from the sitemap, taking the date from the URL", () => {
    const xml = `<urlset><url><loc>https://www.mis.ntpu.edu.tw/2026/10/06/cathaylife_interview/</loc></url>
      <url><loc>https://www.mis.ntpu.edu.tw/2021/11/19/%e6%89%80%e4%b8%8a/</loc></url>
      <url><loc>https://evil.example.com/2026/10/06/x/</loc></url><url><loc>https://www.mis.ntpu.edu.tw/admissions/</loc></url></urlset>`;
    const list = misSite.parseList(xml);
    expect(list.external).toBe(2);
    expect(list.items.map((i) => [i.date, i.path])).toEqual([
      ["2026-10-06", "/2026/10/06/cathaylife_interview/"],
      ["2021-11-19", "/2021/11/19/%e6%89%80%e4%b8%8a/"],
    ]);
    const first = list.items[0]!;
    expect(first.id).toMatch(/^mis20261006[0-9a-f]{8}$/);
    expect(misPostId("/2026/10/06/cathaylife_interview/")).toBe(first.id);
    expect(misSite.detailUrl(first.id, first)).toBe("https://www.mis.ntpu.edu.tw/2026/10/06/cathaylife_interview/");
    expect(() => misSite.detailRequest(first.id, list.items[1])).toThrow();
    expect(() => misSite.parseList("<urlset></urlset>")).toThrow(/sitemap/);
  });

  it("parses a post and a page", () => {
    const post = misSite.parseDetail(
      `<h1 class="entry-title">【徵才】實習計畫</h1><div class="entry-content"><div class="post-content"><p>投遞時間</p><a href="/wp-content/uploads/a.pdf">簡章</a></div></div>`,
      "mis20261006aaaaaaaa",
    );
    expect(post.title).toBe("【徵才】實習計畫");
    expect(post.bodyHtml).toContain("投遞時間");
    expect(post.attachments).toEqual([{ name: "簡章", url: "https://www.mis.ntpu.edu.tw/wp-content/uploads/a.pdf" }]);
    expect(() => misSite.parseDetail("<html></html>", "mis20261006aaaaaaaa")).toThrow(/entry-title/);
    const page = parseMisPage(`<h1 class="entry-title">招生資訊</h1><div class="entry-content"><p>甄試</p></div>`);
    expect(page).toMatchObject({ title: "招生資訊" });
    expect(misPageKey("/admissions/")).toBe("mispadmissions");
    expect(misPageKey("/eng/")).toBe("mispeng0");
  });
});
