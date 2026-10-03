import { IngestionError } from "../../shared/errors";
import { AnnouncementSchema } from "../../shared/schemas";
import { personalDataReason } from "../personal-data";
import type { HtmlNewsConfig, SourceDefinition } from "../types";
import { bodyText, clean, HTML_SITES, taiwanDateToIso, type HtmlSite, type ListItem } from "./html-sites";
import type { Adapter, AdapterRecord, KnownRecord, Step, StepOutcome } from "./types";
import { decodeUtf8 } from "./types";

/** 列表最多翻幾頁（語言中心目前約 73 頁）。 */
const MAX_LIST_PAGES = 200;

function stripEllipsis(title: string): string {
  return title.replace(/(\.{3}|…)$/, "").trim();
}

/** 列表上的標題或日期跟資料庫不一致，代表官網改過，要重抓內文。 */
function changedOnList(item: ListItem, known: KnownRecord): boolean {
  if (known.title !== null && !known.title.includes(stripEllipsis(item.title))) return true;
  if (item.date && known.publishedAt !== null && taiwanDateToIso(item.date) !== known.publishedAt) return true;
  return false;
}

interface Candidate {
  item: ListItem;
  rank: number;
  verifiedAt: string;
}

/** 依優先順序挑出這次要抓內文的公告：新的 → 列表有變動的 → 最久沒驗證的。 */
export function selectDetails(
  items: ListItem[],
  known: Map<string, KnownRecord>,
  config: HtmlNewsConfig,
  nowIso: string,
  reverifyBefore?: string,
): { chosen: ListItem[]; deferred: number } {
  // 一般情況：超過 reverifyAfterSeconds 沒驗證的才重抓。指定 reverifyBefore 時，
  // 在那之前驗證過的也重抓；分批執行時，已重新驗證過的不會再被挑到，留到下一次的數量會逐次減少。
  const normal = Date.parse(nowIso) - config.reverifyAfterSeconds * 1000;
  const forced = reverifyBefore ? Date.parse(reverifyBefore) : Number.NEGATIVE_INFINITY;
  const staleBefore = Math.max(normal, Number.isNaN(forced) ? Number.NEGATIVE_INFINITY : forced);
  const candidates: Candidate[] = [];
  for (const item of items) {
    const k = known.get(item.id);
    if (!k) candidates.push({ item, rank: 0, verifiedAt: "" });
    else if (changedOnList(item, k)) candidates.push({ item, rank: 1, verifiedAt: k.verifiedAt });
    else if (Date.parse(k.verifiedAt) < staleBefore) candidates.push({ item, rank: 2, verifiedAt: k.verifiedAt });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.verifiedAt.localeCompare(b.verifiedAt));
  const chosen = candidates.slice(0, config.maxDetailsPerRun).map((c) => c.item);
  return { chosen, deferred: candidates.length - chosen.length };
}

function detailStep(source: SourceDefinition, site: HtmlSite, config: HtmlNewsConfig, item: ListItem): Step {
  return {
    request: site.detailRequest(item.id),
    fatal: false,
    async handle(bytes): Promise<StepOutcome> {
      const detail = site.parseDetail(decodeUtf8(bytes), item.id);
      const text = bodyText(detail.bodyHtml);
      const outcome: StepOutcome = { parsed: 1, records: [], rejected: [], skipped: 0 };
      const guard = config.personalDataGuard;
      const privacy = guard === "off" ? null : personalDataReason(detail.title, text, guard);
      if (privacy) {
        outcome.rejected.push({ id: item.id, reason: privacy, countsTowardDrift: false });
        return outcome;
      }
      const candidate = {
        id: item.id,
        unit: source.sourceUnit,
        title: detail.title || item.title,
        publishedAt: taiwanDateToIso(detail.date || item.date),
        bodyText: text,
        attachments: [...detail.attachments].sort((a, b) =>
          a.url === b.url ? a.name.localeCompare(b.name) : a.url < b.url ? -1 : 1,
        ),
        sourceUrl: site.detailUrl(item.id),
      };
      const parsed = AnnouncementSchema.safeParse(candidate);
      if (!parsed.success) {
        const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
        outcome.rejected.push({ id: item.id, reason: `invalid: ${fields}`, countsTowardDrift: true });
        return outcome;
      }
      const a = parsed.data;
      const record: AdapterRecord = {
        id: a.id,
        payload: a,
        title: a.title,
        searchText: [a.title, a.bodyText, ...a.attachments.map((f) => f.name)].join("\n"),
        sourceUrl: a.sourceUrl,
        publishedAt: a.publishedAt,
      };
      outcome.records.push(record);
      return outcome;
    },
  };
}

/**
 * 伺服器端產生 HTML 的公告網站（圖書館、語言中心）。
 * 每次執行都翻完整個列表（判斷哪些公告還在），再依優先順序抓有限數量的內文，
 * 其餘留到下一次；沒有變動的公告不重抓，只記為「仍在官網上」。
 */
export const htmlNewsAdapter: Adapter = {
  start(source) {
    if (source.adapter.kind !== "html-news") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    const config = source.adapter;
    const site = HTML_SITES[config.site];
    const listed = new Map<string, ListItem>();

    const listStep = (page: number): Step => ({
      request: site.listRequest(page),
      fatal: true,
      async handle(bytes, ctx): Promise<StepOutcome> {
        const list = site.parseList(decodeUtf8(bytes));
        if (page === 1 && list.items.length === 0 && (await ctx.activeCount()) > 0) {
          throw new IngestionError("PARSER_DRIFT", "list returned zero items but canonical data exists");
        }
        for (const item of list.items) if (!listed.has(item.id)) listed.set(item.id, item);
        const outcome: StepOutcome = {
          parsed: list.items.length + list.external,
          records: [],
          rejected: [],
          skipped: list.external,
          seenIds: list.items.map((i) => i.id),
        };
        if (page < list.totalPages) {
          if (page + 1 > MAX_LIST_PAGES) throw new IngestionError("PARSER_DRIFT", "list has too many pages");
          outcome.next = [listStep(page + 1)];
          return outcome;
        }
        // 列表走完：決定這次要抓哪些內文。
        const items = [...listed.values()];
        const known = await ctx.known(items.map((i) => i.id));
        const { chosen, deferred } = selectDetails(items, known, config, ctx.nowIso, ctx.reverifyBefore);
        outcome.listComplete = true;
        outcome.deferred = deferred;
        outcome.next = chosen.map((item) => detailStep(source, site, config, { ...item, title: clean(item.title) }));
        return outcome;
      },
    });

    return [listStep(1)];
  },
};
