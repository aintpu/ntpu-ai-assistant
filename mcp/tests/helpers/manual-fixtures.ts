import { enabledSources } from "../../src/ingestion/source-registry";
import type { ManualInbox } from "../../src/ingestion/types";

/** R2 manual/ 的記憶體版本；可以移除檔案、改內容、改 content-type。 */
export class MemoryManualInbox implements ManualInbox {
  readonly files = new Map<string, { text: string; contentType: string }>();
  reads: string[] = [];

  set(path: string, text: string, contentType = path.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8") {
    this.files.set(path, { text, contentType });
  }

  async get(path: string) {
    this.reads.push(path);
    const f = this.files.get(path);
    return f ? { bytes: new TextEncoder().encode(f.text), contentType: f.contentType } : null;
  }
}

export function regulationsMd(docs: { title: string; body: string; url?: string; tags?: string }[]): string {
  return docs
    .map((d) =>
      [
        `## ${d.title}`,
        ...(d.url ? [`來源網址：${d.url}`] : []),
        ...(d.tags ? [`標籤：${d.tags}`] : []),
        "",
        "### Page 1",
        d.body,
        "",
        "---",
        "",
      ].join("\n"),
    )
    .join("\n");
}

export function faqMd(entries: { q: string; a: string; id?: string; url?: string; date?: string; topic?: string }[]): string {
  return [
    "# 常見問題",
    "",
    ...entries.flatMap((e) => [
      `### ${e.q}`,
      "",
      e.a,
      "",
      ...(e.id ? [`FAQ 編號：${e.id}`, ""] : []),
      `業務主題：${e.topic ?? "一般"}`,
      "",
      `來源網址：${e.url ?? "https://new.ntpu.edu.tw/ord"}`,
      "",
      `來源日期：${e.date ?? "2026-09-01"}`,
      "",
      "聯絡窗口：承辦人，分機 1234",
      "",
    ]),
  ].join("\n");
}

export interface CatalogRowInput {
  owner: string;
  title: string;
  fileUrl?: string | null;
  sourcePage?: string | null;
  tags?: string[];
  updatedDate?: string | null;
  catalog?: "academic" | "admin";
}

export function catalogJson(rows: CatalogRowInput[]): string {
  return JSON.stringify({
    generatedFrom: [],
    rows: rows.map((r) => ({
      owner: r.owner,
      title: r.title,
      tags: r.tags ?? ["法規"],
      fileUrl: r.fileUrl === undefined ? `https://cms-carrier.ntpu.edu.tw/uploads/${encodeURIComponent(r.title)}.pdf` : r.fileUrl,
      fileType: "pdf",
      updatedDate: r.updatedDate ?? "01/22/2025",
      sourcePage: r.sourcePage ?? null,
      notes: null,
      catalog: r.catalog ?? "admin",
      sourceFile: r.catalog === "academic" ? "crawler_data/北大學術單位法規彙整.xlsx" : "crawler_data/北大行政單位法規彙整.xlsx",
    })),
  });
}

/** 每個已登記的人工檔案都放一份最小但合法的內容，讓「全部來源」的抓取能完整成功。 */
export function seedManualInbox(inbox: MemoryManualInbox): MemoryManualInbox {
  for (const source of enabledSources()) {
    const cfg = source.adapter;
    if (cfg.kind === "manual-regulations") {
      inbox.set(
        cfg.fullTextFile,
        regulationsMd([{ title: `${cfg.catalogOwners[0]}學生請假規定`, body: "第一條 學生請假應依本規定辦理。" }]),
      );
    } else if (cfg.kind === "manual-faq") {
      for (const { file, unit } of cfg.files) {
        inbox.set(file, faqMd([{ q: `${unit} 的服務時間是？`, a: "週一至週五 8:00–17:00。", id: `${unit.toUpperCase()}-T-001` }]));
      }
    }
  }
  inbox.set(
    "derived/regulation-catalog.json",
    catalogJson([
      { owner: "學生事務處", title: "學生事務處學生請假規定" },
      { owner: "法律學院", title: "法律學院院務會議設置辦法", catalog: "academic" },
      { owner: "秘書室", title: "秘書室公文處理要點" },
    ]),
  );
  return inbox;
}
