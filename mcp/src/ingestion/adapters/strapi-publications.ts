import { IngestionError, safeMessage } from "../../shared/errors";
import { normalizeAnnouncement } from "../normalizers/announcement.normalizer";
import { personalDataReason } from "../personal-data";
import { strapiPublicationsParser as parser, type StrapiPublication } from "../parsers/strapi-publications.parser";
import type { SourceDefinition } from "../types";
import type { Adapter, AdapterRecord, RejectedRecord, Step } from "./types";

/** 隔離紀錄的識別值：優先用來源的 _id，沒有就用頁碼與位置，確保每筆都追得到原始檔。 */
function rejectKey(row: StrapiPublication, page: number, index: number): string {
  const id = typeof row._id === "string" ? row._id.trim().slice(0, 100) : "";
  return id || `page-${page}-row-${index}`;
}

function pageStep(source: SourceDefinition, page: number, nowIso: string): Step {
  return {
    request: parser.buildRequest(source, page, nowIso),
    fatal: true,
    async handle(bytes, ctx) {
      const rows = parser.parse(bytes);
      if (page === 0 && rows.length === 0 && (await ctx.activeCount()) > 0) {
        throw new IngestionError("PARSER_DRIFT", "source returned zero records but canonical data exists");
      }
      const records: AdapterRecord[] = [];
      const rejected: RejectedRecord[] = [];
      let skipped = 0;
      rows.forEach((row, index) => {
        if (parser.exclusionReason(row)) {
          skipped++;
          return;
        }
        let a;
        try {
          a = normalizeAnnouncement(row, source);
        } catch (err) {
          rejected.push({ id: rejectKey(row, page, index), reason: safeMessage(err), countsTowardDrift: true });
          return;
        }
        const guard = source.adapter.kind === "strapi-publications" && source.adapter.personalDataGuard;
        const privacy = guard ? personalDataReason(a.title, a.bodyText) : null;
        if (privacy) {
          rejected.push({ id: a.id, reason: privacy, countsTowardDrift: false });
          return;
        }
        records.push({
          id: a.id,
          payload: a,
          title: a.title,
          searchText: [a.title, a.bodyText, ...a.attachments.map((f) => f.name)].join("\n"),
          sourceUrl: a.sourceUrl,
          publishedAt: a.publishedAt,
        });
      });
      const full = rows.length >= parser.pageSize;
      return {
        parsed: rows.length,
        records,
        rejected,
        skipped,
        next: full && page + 1 < parser.maxPages ? [pageStep(source, page + 1, nowIso)] : [],
        listComplete: !full,
      };
    },
  };
}

/** new.ntpu.edu.tw 各處室公告（學校 Strapi GraphQL），每頁 100 筆、翻到短頁為止。 */
export const strapiPublicationsAdapter: Adapter = {
  start(source, nowIso) {
    return [pageStep(source, 0, nowIso)];
  },
};
