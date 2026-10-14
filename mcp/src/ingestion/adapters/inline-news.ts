import { IngestionError } from "../../shared/errors";
import { AnnouncementSchema } from "../../shared/schemas";
import type { SourceDefinition } from "../types";
import { bodyText, COLLEGE_SITES, collegeId, parseAccNews, taiwanDateToIso } from "./html-sites";
import type { Adapter, AdapterRecord, StepOutcome } from "./types";
import { decodeUtf8 } from "./types";

/**
 * 最新消息全文直接顯示在列表頁的網站（會計系 news.php、r_news.php）：每頁抓一次，列表上的每則直接成為一筆公告。
 * 沒有內文頁，官方連結指向該則所在的列表頁。再往後的分頁要靠瀏覽器 session，抓不到，只收列表上看得到的公告；
 * 從列表消失的公告依一般規則（連續幾次沒看到）才標記為已移除。
 */
export const inlineNewsAdapter: Adapter = {
  start(source: SourceDefinition) {
    const cfg = source.adapter;
    if (cfg.kind !== "inline-news") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    const spec = COLLEGE_SITES[cfg.site];
    if (cfg.pages.length === 0 || cfg.pages.length > 10 || !cfg.pages.every((p) => source.entrypoints.includes(p.path))) {
      throw new IngestionError("URL_NOT_ALLOWED", `invalid list pages for ${source.id}`);
    }
    const seen = new Set<string>();
    return cfg.pages.map((page, index) => {
      const target = page.query ? `${page.path}?${new URLSearchParams(page.query)}` : page.path;
      return {
        request: { target, path: page.path, method: "GET" as const, ...(page.query ? { query: page.query } : {}) },
        // 第一頁（最新消息）失敗代表網站異常，整次中止；第二頁之後失敗只記錄
        fatal: index === 0,
        async handle(bytes): Promise<StepOutcome> {
          const items = parseAccNews(decodeUtf8(bytes));
          if (index === 0 && items.length === 0) throw new IngestionError("PARSER_DRIFT", "news list has no items");
          const outcome: StepOutcome = { parsed: items.length, records: [], rejected: [], skipped: 0, listComplete: index === cfg.pages.length - 1 };
          for (const item of items) {
            const id = collegeId(spec, item.number);
            if (seen.has(id)) {
              outcome.skipped++;
              continue;
            }
            seen.add(id);
            const parsed = AnnouncementSchema.safeParse({
              id,
              unit: source.sourceUnit,
              title: item.title,
              publishedAt: taiwanDateToIso(item.date),
              bodyText: bodyText(item.bodyHtml),
              attachments: [],
              sourceUrl: `${spec.origin}${target}`,
            });
            if (!parsed.success) {
              const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
              outcome.rejected.push({ id, reason: `invalid: ${fields}`, countsTowardDrift: true });
              continue;
            }
            const a = parsed.data;
            const record: AdapterRecord = {
              id: a.id,
              payload: a,
              title: a.title,
              searchText: [a.title, a.bodyText].join("\n"),
              sourceUrl: a.sourceUrl,
              publishedAt: a.publishedAt,
            };
            outcome.records.push(record);
          }
          return outcome;
        },
      };
    });
  },
};
