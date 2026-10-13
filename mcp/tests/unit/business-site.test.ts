import { describe, expect, it } from "vitest";
import { aacsbId, aacsbParam, aacsbSite, parseAacsbGroup } from "../../src/ingestion/adapters/html-sites";

const shell = (inner: string) => `<html><body><header>選單</header><div role="main" class="main">${inner}</div><div id="footer"></div></body></html>`;

describe("商學院網站（www.aacsb.ntpu.edu.tw）", () => {
  it("lists every news number up to the newest one on the list", () => {
    const html = shell(`<a href="view.php?id=${aacsbParam(2276)}">a</a><a href="http://www.aacsb.ntpu.edu.tw/view.php?id=${aacsbParam(2270)}">b</a>`);
    const list = aacsbSite.parseList(html);
    expect(list.items.length).toBe(2276);
    expect(list.items[0]!.id).toBe("b0002276");
    expect(list.items.at(-1)!.id).toBe("b0000001");
    expect(aacsbSite.detailUrl(aacsbId(2276))).toBe(`https://www.aacsb.ntpu.edu.tw/view.php?id=${btoa("2276")}`);
  });

  it("parses a news item and recognises a deleted (blank) number", () => {
    const item = shell(`<div class="blog-posts"><h3>最新消息</h3><article class="post"><div class="post-content"><p><h3>恭賀！商學院教師獲獎</h3></p></div></article>
      <p>本院五位教師入榜。</p><a href="uploads/file/cus2_x.pdf">附件1</a><p>聯絡人：</p><p>刊登時間：2026-10-12 17:08:47</p></div>`);
    const d = aacsbSite.parseDetail(item, "b0002276");
    expect(d.title).toBe("恭賀！商學院教師獲獎");
    expect(d.date).toBe("2026-10-12");
    expect(d.bodyHtml).toContain("本院五位教師入榜");
    expect(d.bodyHtml).not.toContain("刊登時間");
    expect(d.attachments).toEqual([{ name: "附件1", url: "https://www.aacsb.ntpu.edu.tw/uploads/file/cus2_x.pdf" }]);
    const blank = aacsbSite.parseDetail(shell(`<div class="blog-posts"><h3>最新消息</h3></div>`), "b0000500");
    expect(blank).toMatchObject({ title: "", date: "", bodyHtml: "" });
  });

  it("splits a page group into one record per visible tab", () => {
    const html = shell(`<ul class="nav nav-tabs"><li class="active"><a href="#t1">歷史沿革</a></li><li><a href="#t2">行政團隊</a></li>
      <!--<li><a href="#t3">舊分頁</a></li>--></ul>
      <div class="tab-pane active" id="t1">商學院創立可追溯至1955年</div><div class="tab-pane" id="t2">院長、副院長</div><div class="tab-pane" id="t3">隱藏內容</div>`);
    const pages = parseAacsbGroup(html, 1);
    expect(pages.map((p) => [p.key, p.title, p.path])).toEqual([
      ["cobp001t01", "歷史沿革", "/page.php?id=1&ids=1"],
      ["cobp001t02", "行政團隊", "/page.php?id=1&ids=2"],
    ]);
  });
});
