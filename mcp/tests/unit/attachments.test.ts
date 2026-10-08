import { describe, expect, it } from "vitest";
import { attachmentCandidates, attachmentsAdapter } from "../../src/ingestion/adapters/attachments";
import { xmlToText } from "../../src/ingestion/extract/office";
import { getSource } from "../../src/ingestion/source-registry";
import { assertRegistryValid } from "../../src/ingestion/source-registry";
import { resolveRequestUrl } from "../../src/ingestion/url-policy";
import { snippetAround } from "../../src/mcp/attachment-service";

const source = getSource("announcement-attachments")!;
const CMS = "https://cms-carrier.ntpu.edu.tw/uploads/";
const row = (unit: string, files: { name: string; url: string }[], publishedAt = "2026-10-01T00:00:00.000Z") => ({
  unit,
  announcementId: `${unit}-1`,
  title: `${unit} 公告`,
  publishedAt,
  attachments: JSON.stringify(files),
});

describe("attachment URL policy", () => {
  it("the registry with dynamic path rules is valid", () => {
    expect(() => assertRegistryValid()).not.toThrow();
  });

  it.each([
    "/uploads/a.pdf",
    "/uploads/V2_115_cb15457536.pdf",
    "/uploads/_8e8f8b9bb4.odt",
    "/uploads/poster.PNG",
  ])("allows %s", (path) => {
    expect(resolveRequestUrl(source, { path }).toString()).toBe(`https://cms-carrier.ntpu.edu.tw${path}`);
  });

  it.each([
    "/uploads/../admin/a.pdf",
    "/uploads/sub/a.pdf",
    "/uploads/a.exe",
    "/uploads/a.pdf.html",
    "/upload/a.pdf",
    "/uploads/a b.pdf",
    "/strapi",
  ])("rejects %s", (path) => {
    expect(() => resolveRequestUrl(source, { path })).toThrow();
  });

  it("never accepts query parameters on attachment paths", () => {
    expect(() => resolveRequestUrl(source, { path: "/uploads/a.pdf", query: { x: "1" } })).toThrow(/not allowed/);
  });
});

describe("attachment candidates and batches", () => {
  it("keeps only cms-carrier files, dedupes by URL, and picks the first office alphabetically", async () => {
    const list = await attachmentCandidates([
      row("osa", [{ name: "簡章.pdf", url: `${CMS}a.pdf` }, { name: "外部.pdf", url: "https://example.com/uploads/b.pdf" }]),
      row("oaa", [{ name: "簡章.pdf", url: `${CMS}a.pdf` }, { name: "壞網址", url: "not a url" }]),
      row("ord", [{ name: "x.zip", url: `${CMS}c.zip` }]),
    ]);
    expect(list.map((c) => [c.url, c.unit, c.postedBy])).toEqual([[`${CMS}a.pdf`, "oaa", ["oaa", "osa"]]]);
    expect(list[0]!.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("limits each run, caps OCR images, and skips handled or recently failed files", async () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => ({ name: `p${i}.png`, url: `${CMS}p${i}.png` })),
      ...Array.from({ length: 60 }, (_, i) => ({ name: `d${i}.pdf`, url: `${CMS}d${i}.pdf` })),
    ];
    const candidates = await attachmentCandidates([row("oaa", files)]);
    const handled = new Set([`oaa:${candidates.find((c) => c.url.endsWith("/d0.pdf"))!.id}`]);
    const failed = new Set([`${CMS}d1.pdf`]);
    const plan = await attachmentsAdapter.plan!(source, "2026-10-08T00:00:00.000Z", {
      announcementAttachments: async () => [row("oaa", files)],
      handledKeys: async () => handled,
      recentlyFailedTargets: async () => failed,
    });
    const targets = plan.steps.map((s) => s.request.target);
    expect(targets).toHaveLength(40);
    expect(targets.filter((t) => t.endsWith(".png"))).toHaveLength(15);
    expect(targets).not.toContain(`${CMS}d0.pdf`);
    expect(targets).not.toContain(`${CMS}d1.pdf`);
    expect(plan.deferred).toBe(90 - 2 - 40);
    expect(plan.seen).toHaveLength(90 - 40);
  });
});

describe("text extraction helpers", () => {
  it("keeps table cells and paragraphs from ODF and DOCX XML", () => {
    const odt =
      "<table:table-row><table:table-cell><text:p>系所</text:p></table:table-cell><table:table-cell><text:p>資訊管理研究所</text:p></table:table-cell></table:table-row>" +
      "<text:p>考試科目&amp;比例</text:p>";
    expect(xmlToText(odt)).toBe("系所\t資訊管理研究所\n考試科目&比例");
    expect(xmlToText("<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p>")).toBe("第一段\n第二段");
  });

  it("snippets start near the first keyword", () => {
    const text = `${"封面 ".repeat(200)}資訊管理研究所 考試科目 計算機概論`;
    expect(snippetAround(text, ["計算機概論"])).toContain("計算機概論");
    expect(snippetAround(text, ["計算機概論"]).startsWith("…")).toBe(true);
  });
});

describe("OCR output cleanup", () => {
  it("drops the model's 「（無文字）」 marker even after real text", async () => {
    const { ocrImage } = await import("../../src/ingestion/extract/ocr");
    const ai = (response: string) => ({ run: async () => ({ response }) });
    const png = new Uint8Array([137, 80, 78, 71]);
    expect(await ocrImage(ai("（無文字）"), "m", png, "image/png")).toBe("");
    expect(await ocrImage(ai("Deadline October 30, 2026  （無文字"), "m", png, "image/png")).toBe("Deadline October 30, 2026");
  });
});
