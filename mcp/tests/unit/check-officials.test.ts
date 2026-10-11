import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error 純 JS 腳本，沒有型別宣告
import { applyCandidates, candidateNames, checkOfficials } from "../../scripts/check-officials.mjs";
import { OFFICIALS } from "../../src/ingestion/officials";

const page = (content: string, content_en = "") => ({ content, content_en, updatedAt: "2026-10-11T00:00:00Z" });

describe("現任主管換人偵測（程式抓候選姓名，人工確認後才上線）", () => {
  it("picks the standalone name, not past directors or department fragments", () => {
    expect(candidateNames("現任 歷任 王小明 政治大學哲學系博士 歷任主任 徐美華 主任", "通識教育中心主任")[0]).toBe("王小明");
    expect(candidateNames("治校理念 與校長有約 李大同 美國大學 電機工程學系 教授", "校長")[0]).toBe("李大同");
    expect(candidateNames("學歷 經歷", "教務長")).toEqual([]);
  });

  it("flags only officials whose name left the page", () => {
    const officials = OFFICIALS.filter((o) => ["/president", "/oaa/director", "/oia/director"].includes(o.path));
    const pages = new Map<string, unknown>([
      ["/president", page("與校長有約 林道通 校長")],
      ["/oaa/director", page("教務長 李大同 教授 學歷")],
      ["/oia/director", page("國際長", "Thijs A. Velema")],
    ]);
    const results = checkOfficials(officials, pages);
    expect(results.map((r: { status: string }) => r.status)).toEqual(["ok", "changed", "ok"]);
    expect(results[1].candidates[0]).toBe("李大同");
    expect(checkOfficials(officials.slice(0, 1), new Map())[0].status).toBe("missing_page");
  });

  it("rewrites only that entry and clears the predecessor's English name and term", () => {
    const src = readFileSync(decodeURIComponent(new URL("../../src/ingestion/officials.ts", import.meta.url).pathname), "utf8");
    const out = applyCandidates(
      src,
      [{ status: "changed", path: "/oaa/director", title: "教務長", oldName: "陳婉琪", candidates: ["李大同"] }],
      "2026-10-11",
    );
    const block = out.slice(out.indexOf('path: "/oaa/director"'), out.indexOf("\n  },", out.indexOf('path: "/oaa/director"')));
    expect(block).toContain('name: "李大同"');
    expect(block).toContain("前任：陳婉琪");
    expect(block).not.toContain("Wan-Chi");
    expect(block).not.toContain("term:");
    expect(block).toContain('titleEnSearch: ["dean of academic affairs"]');
    // 其他人不動
    expect(out.replace(block, "")).toBe(src.replace(src.slice(src.indexOf('path: "/oaa/director"'), src.indexOf("\n  },", src.indexOf('path: "/oaa/director"'))), ""));
  });
});
