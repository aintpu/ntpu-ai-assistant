import { describe, expect, it } from "vitest";
import {
  gregorianDateIso,
  normalizeTitle,
  parseCatalogFile,
  parseFaqMarkdown,
  parseRegulationsMarkdown,
  singleUrl,
} from "../../src/ingestion/manual-parse";

describe("parseRegulationsMarkdown", () => {
  it("reads metadata lines, drops page headings and separators, and keeps text as written", () => {
    const docs = parseRegulationsMarkdown(
      [
        "## 1.國立臺北大學教授休假研究辦法",
        "來源網址：https://cms-carrier.ntpu.edu.tw/uploads/a.pdf",
        "標籤：法規,教師",
        "上傳日期：11/07/2024",
        "",
        "### Page 1",
        "第一條 本辦法依…訂定。",
        "### Page 2",
        "第二條 （內容）",
        "",
        "---",
        "",
        "## 國立臺北大學學生輔導辦法",
        "### 全文",
        "第一條 為促進學生身心健康…",
      ].join("\n"),
    );
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      title: "1.國立臺北大學教授休假研究辦法",
      fileUrl: "https://cms-carrier.ntpu.edu.tw/uploads/a.pdf",
      tags: ["法規", "教師"],
      uploadDate: "11/07/2024",
      occurrence: 0,
    });
    expect(docs[0]!.bodyText).toBe("第一條 本辦法依…訂定。\n\n第二條 （內容）");
    expect(docs[1]).toMatchObject({ fileUrl: null, tags: [], uploadDate: null, bodyText: "第一條 為促進學生身心健康…" });
  });

  it("numbers repeated titles so each gets a stable, distinct id", () => {
    const docs = parseRegulationsMarkdown("## 辦法A\n內容一\n## 辦法 A\n內容二\n## 辦法B\n內容三");
    expect(docs.map((d) => d.occurrence)).toEqual([0, 1, 0]);
  });

  it("does not treat ### headings or a leading BOM as new regulations", () => {
    const docs = parseRegulationsMarkdown("﻿## 辦法\n### Page 1\n內容");
    expect(docs).toHaveLength(1);
  });
});

describe("parseFaqMarkdown", () => {
  it("splits the answer from the field block and keeps all fields", () => {
    const [e] = parseFaqMarkdown(
      [
        "# 常見問題",
        "",
        "### 研發處的電話是多少？",
        "",
        "02-8674-1111。申請時間：每年 3 月。",
        "",
        "FAQ 編號：ORD-HQ-002",
        "",
        "承辦組別：處本部",
        "",
        "來源網址：https://new.ntpu.edu.tw/ord",
        "",
        "聯絡窗口：王小明，分機 66001",
      ].join("\n"),
    );
    // 「申請時間：」在回答裡，不能被當成欄位區的開頭。
    expect(e!.answer).toBe("02-8674-1111。申請時間：每年 3 月。");
    expect(e!.fields).toMatchObject({ "FAQ 編號": "ORD-HQ-002", 承辦組別: "處本部", 來源網址: "https://new.ntpu.edu.tw/ord" });
    expect(e!.details).toContain("聯絡窗口：王小明，分機 66001");
  });

  it("keeps an answer whose first line looks like a field (適用對象：…)", () => {
    const [e] = parseFaqMarkdown("### 場地怎麼借？\n\n適用對象：校內外單位\n\n線上預約。\n\nFAQ 編號：EEC-1\n來源網址：https://x.ntpu.edu.tw/");
    expect(e!.answer).toBe("適用對象：校內外單位\n\n線上預約。");
    expect(e!.fields["FAQ 編號"]).toBe("EEC-1");
  });

  it("handles a question with no field block", () => {
    const [e] = parseFaqMarkdown("### 問題？\n\n回答。");
    expect(e).toMatchObject({ question: "問題？", answer: "回答。", fields: {}, details: "" });
  });
});

describe("helpers", () => {
  it("normalizeTitle ignores whitespace and file extensions, like the AIA backend", () => {
    expect(normalizeTitle(" 國立臺北大學 學生請假規定.pdf ")).toBe(normalizeTitle("國立臺北大學學生請假規定"));
    expect(normalizeTitle("辦法.DOCX")).toBe("辦法");
  });

  it("singleUrl keeps parentheses and encodes spaces instead of truncating", () => {
    expect(singleUrl("https://clc.ntpu.edu.tw/uploads/表(1141022修正).docx")).toBe(
      "https://clc.ntpu.edu.tw/uploads/%E8%A1%A8(1141022%E4%BF%AE%E6%AD%A3).docx",
    );
    expect(singleUrl("https://clc.ntpu.edu.tw/uploads/Application Form.pdf")).toBe(
      "https://clc.ntpu.edu.tw/uploads/Application%20Form.pdf",
    );
    expect(singleUrl("javascript:alert(1)")).toBeNull();
    expect(singleUrl("見 https://new.ntpu.edu.tw/ord 說明")).toBe("https://new.ntpu.edu.tw/ord");
    expect(singleUrl("")).toBeNull();
  });

  it("gregorianDateIso converts only unambiguous western dates", () => {
    expect(gregorianDateIso("01/22/2025")).toBe("2025-01-22T00:00:00.000Z");
    expect(gregorianDateIso("2024/08/14")).toBe("2024-08-14T00:00:00.000Z");
    expect(gregorianDateIso("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
    expect(gregorianDateIso("105/03/10")).toBeNull(); // 民國年：保留原文，不換算
    expect(gregorianDateIso("02/30/2025")).toBeNull();
    expect(gregorianDateIso(null)).toBeNull();
  });

  it("parseCatalogFile validates the catalog shape", () => {
    expect(() => parseCatalogFile({})).toThrow();
    expect(() => parseCatalogFile({ rows: [{ owner: "x", title: "y", catalog: "other" }] })).toThrow();
    const { rows } = parseCatalogFile({
      rows: [{ owner: "秘書室", title: "要點", tags: ["法規", 3], fileUrl: "not a url", catalog: "admin", sourceFile: "crawler_data/a.xlsx" }],
    });
    expect(rows[0]).toMatchObject({ tags: ["法規"], fileUrl: null, catalog: "admin" });
  });
});
