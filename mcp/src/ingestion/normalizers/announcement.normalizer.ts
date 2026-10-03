import { AnnouncementSchema, type Announcement } from "../../shared/schemas";
import { IngestionError } from "../../shared/errors";
import { htmlToText } from "../html-text";
import type { StrapiPublication } from "../parsers/strapi-publications.parser";
import type { SourceDefinition } from "../types";

const CMS_ORIGIN = "https://cms-carrier.ntpu.edu.tw";

function absoluteFileUrl(raw: string): string {
  const url = new URL(raw.trim(), `${CMS_ORIGIN}/`);
  url.hash = "";
  return url.toString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
}

/**
 * strapi 公告 → canonical Announcement。只做決定性的轉換，不補任何官網沒有的內容。
 * 不合格的資料丟出 VALIDATION_FAILED，由呼叫端記錄並跳過，不會寫進資料庫。
 */
export function normalizeAnnouncement(item: StrapiPublication, source: SourceDefinition): Announcement {
  const id = typeof item._id === "string" ? item._id.trim() : "";
  const publishedAtRaw = typeof item.publishAt === "string" ? item.publishAt : "";
  const publishedAt = Number.isNaN(Date.parse(publishedAtRaw)) ? "" : new Date(publishedAtRaw).toISOString();

  const files = Array.isArray(item.files) ? item.files : [];
  const seen = new Set<string>();
  const attachments: Announcement["attachments"] = [];
  for (const file of files) {
    if (file === null || typeof file !== "object") continue;
    const { name, url } = file as { name?: unknown; url?: unknown };
    if (typeof url !== "string" || !url.trim()) continue;
    let abs: string;
    try {
      abs = absoluteFileUrl(url);
    } catch {
      continue;
    }
    if (!abs.startsWith("https://")) continue;
    const entry = { name: text(name) || abs.split("/").pop() || abs, url: abs };
    const dedupeKey = `${entry.url}\n${entry.name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    attachments.push(entry);
  }
  attachments.sort((a, b) => (a.url === b.url ? a.name.localeCompare(b.name) : a.url < b.url ? -1 : 1));

  const candidate = {
    id,
    unit: source.sourceUnit,
    title: text(item.title),
    publishedAt,
    bodyText: htmlToText(typeof item.content === "string" ? item.content : ""),
    attachments,
    sourceUrl: `${source.newsUrlBase}/${id}`,
  };
  const parsed = AnnouncementSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new IngestionError("VALIDATION_FAILED", `announcement ${id || "(no id)"} invalid: ${fields}`);
  }
  return parsed.data;
}
