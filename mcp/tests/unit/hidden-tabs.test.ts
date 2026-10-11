import { describe, expect, it } from "vitest";
import { htmlToText, visibleHtml } from "../../src/ingestion/html-text";

// 秘書室〈成員介紹〉的結構（2026-10-11）：第二個分頁按鈕被註解掉，官網看不到，內容卻還在 HTML 裡
const MEMBERS = `<ul class="nav nav-tabs"><li class="active"><a href="#tab1" data-toggle="tab">秘書室</a></li>
<!--<li><a href="#tab2" data-toggle="tab">大學社會責任辦公室</a></li>--></ul>
<div class="tab-content"><div class="tab-pane fade active in" id="tab1"><h3>主任秘書 胡龍騰教授</h3></div>
<div class="tab-pane fade" id="tab2"><h3>執行長(兼秘書室二組組長) 戴敏育副教授</h3></div></div>`;

describe("只收錄官網看得到的內容", () => {
  it("drops tab panes whose tab button is commented out", () => {
    const text = htmlToText(MEMBERS);
    expect(text).toContain("胡龍騰");
    expect(text).not.toContain("戴敏育");
    expect(text).not.toContain("大學社會責任辦公室");
  });

  it("keeps panes that still have a visible tab button", () => {
    const both = MEMBERS.replace("<!--", "").replace("-->", "");
    expect(htmlToText(both)).toContain("戴敏育");
  });

  it("leaves pages without tabs untouched", () => {
    const html = "<p>一般內容</p><!-- 備註 -->";
    expect(visibleHtml(html)).toBe("<p>一般內容</p>");
  });
});
