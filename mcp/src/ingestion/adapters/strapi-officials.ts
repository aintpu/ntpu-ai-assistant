import { IngestionError, safeMessage } from "../../shared/errors";
import { OfficialSchema } from "../../shared/schemas";
import { htmlToText } from "../html-text";
import { OFFICIALS, type OfficialEntry } from "../officials";
import type { Adapter, AdapterRecord, RejectedRecord, Step } from "./types";
import { parseSections } from "./strapi-sections";

const SITE_ORIGIN = "https://new.ntpu.edu.tw";
const PAGE_PATH = /^\/[a-z0-9][a-z0-9/-]{0,100}$/;

function flat(value: unknown): string {
  return typeof value === "string" ? htmlToText(value).normalize("NFC").replace(/\s+/g, " ") : "";
}

/** 頁面內容與對照表比對：中文姓名必須仍在頁面上；英文頁不再有官方英文姓名時，英文欄留空（不沿用舊值）。 */
export function normalizeOfficial(
  entry: OfficialEntry,
  row: { _id?: unknown; title?: unknown; content?: unknown; content_en?: unknown; updatedAt?: unknown },
): AdapterRecord {
  const zh = flat(row.content);
  const en = flat(row.content_en).toLowerCase();
  if (entry.name && !zh.includes(entry.name)) {
    throw new IngestionError("VALIDATION_FAILED", `${entry.path}: name no longer on page, needs manual review`);
  }
  if (!entry.name && !(entry.nameEnOfficial && en.includes(entry.nameEnOfficial.toLowerCase()))) {
    throw new IngestionError("VALIDATION_FAILED", `${entry.path}: name no longer on page, needs manual review`);
  }
  const enOk = Boolean(entry.nameEnOfficial && en.includes(entry.nameEnOfficial.toLowerCase()));
  const updatedRaw = typeof row.updatedAt === "string" ? row.updatedAt : "";
  const candidate = {
    id: typeof row._id === "string" ? row._id.trim() : "",
    unit: entry.unit,
    title: entry.title,
    name: entry.name,
    nameEn: enOk ? (entry.nameEn ?? null) : null,
    nameEnOfficial: enOk ? (entry.nameEnOfficial ?? null) : null,
    titleEnSearch: entry.titleEnSearch,
    term: entry.term ?? null,
    termSource: entry.termSource ?? null,
    note: entry.nameEnOfficial && !enOk ? "英文頁已無原本的英文姓名，英文姓名留空待重新核對" : (entry.note ?? null),
    path: entry.path,
    pageTitle: flat(row.title),
    pageUpdatedAt: Number.isNaN(Date.parse(updatedRaw)) ? "" : new Date(updatedRaw).toISOString(),
    sourceUrl: new URL(entry.path, SITE_ORIGIN).toString(),
  };
  const parsed = OfficialSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new IngestionError("VALIDATION_FAILED", `official ${entry.path} invalid: ${fields}`);
  }
  const o = parsed.data;
  return {
    id: o.id,
    unit: o.unit,
    payload: o,
    title: `${o.title} ${o.name ?? o.nameEn ?? ""}`.trim(),
    searchText: [o.title, o.name, o.nameEn, o.nameEnOfficial, ...o.titleEnSearch].filter(Boolean).join("\n"),
    sourceUrl: o.sourceUrl,
    publishedAt: o.pageUpdatedAt,
  };
}

/**
 * 現任主管：一次查詢對照表裡所有主管介紹頁（查詢語句固定，不接受外部輸入）。
 * 頁面不見、或姓名已不在頁面上的主管記入隔離區，之前收錄的那筆不再提供。
 */
export const strapiOfficialsAdapter: Adapter = {
  start(source) {
    if (source.adapter.kind !== "strapi-officials") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    const paths = [...new Set(OFFICIALS.map((o) => o.path))];
    if (paths.length === 0 || paths.length > 50 || !paths.every((p) => PAGE_PATH.test(p))) {
      throw new IngestionError("URL_NOT_ALLOWED", `invalid official page paths for ${source.id}`);
    }
    const query = `{ sections(where:{name_in:${JSON.stringify(paths)}}) { _id name title content content_en updatedAt } }`;
    const step: Step = {
      request: {
        target: `${source.entrypoints[0]}#officials`,
        path: source.entrypoints[0]!,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ query }),
      },
      fatal: true,
      async handle(bytes, ctx) {
        const rows = parseSections(bytes) as Record<string, unknown>[];
        if (rows.length === 0 && (await ctx.activeCount()) > 0) {
          throw new IngestionError("PARSER_DRIFT", "source returned zero pages but canonical data exists");
        }
        const records: AdapterRecord[] = [];
        const rejected: RejectedRecord[] = [];
        for (const entry of OFFICIALS) {
          const row = rows.find((r) => r.name === entry.path);
          if (!row) {
            rejected.push({ id: entry.path.replace(/[^a-z0-9]/g, "") || "page", unit: entry.unit, reason: `${entry.path}: page missing`, countsTowardDrift: false });
            continue;
          }
          try {
            records.push(normalizeOfficial(entry, row));
          } catch (err) {
            const id = typeof row._id === "string" ? row._id.slice(0, 100) : entry.path;
            rejected.push({ id, unit: entry.unit, reason: safeMessage(err), countsTowardDrift: false });
          }
        }
        return { parsed: rows.length, records, rejected, skipped: 0, listComplete: true };
      },
    };
    return [step];
  },
};
