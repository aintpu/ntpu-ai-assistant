import { contentHash } from "../../shared/hash";
import { IngestionError, safeMessage } from "../../shared/errors";
import { AttachmentDocSchema, type AttachmentDoc } from "../../shared/schemas";
import { MAX_OCR_BYTES, ocrImage } from "../extract/ocr";
import { officeText } from "../extract/office";
import { pdfText } from "../extract/pdf";
import { personalDataReason } from "../personal-data";
import type { SourceDefinition } from "../types";
import type { Adapter, AdapterRecord, Plan, PlanStore, RejectedRecord, Step } from "./types";

export const ATTACHMENT_HOST = "cms-carrier.ntpu.edu.tw";
/** 附件檔案路徑：/uploads/ 底下單一檔名，不含子目錄、查詢參數或特殊字元。 */
export const ATTACHMENT_PATH = /^\/uploads\/[A-Za-z0-9_.-]{1,200}\.(pdf|odt|ods|odp|docx|jpe?g|png)$/i;
const OFFICE = new Set(["odt", "ods", "odp", "docx"]);
const IMAGE_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
/** 下載或 OCR 失敗（例如 404、模型暫時無法使用）的附件，一天內不重試。 */
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;

interface Candidate {
  id: string;
  unit: string;
  postedBy: string[];
  name: string;
  url: string;
  path: string;
  ext: string;
  announcementId: string;
  announcementTitle: string;
  publishedAt: string | null;
}

/** 附件編號：網址的 SHA-256 前 32 碼（同一個檔案被多個處室刊登時只算一筆）。 */
async function attachmentId(url: string): Promise<string> {
  return (await contentHash(url)).slice(0, 32);
}

/** 從已收錄公告的附件清單整理出候選附件；同一網址只取一筆，處室依字母排序取第一個（每次結果一致）。 */
export async function attachmentCandidates(
  rows: Awaited<ReturnType<PlanStore["announcementAttachments"]>>,
): Promise<Candidate[]> {
  const byUrl = new Map<string, Candidate>();
  for (const row of rows) {
    let list: unknown;
    try {
      list = JSON.parse(row.attachments || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const a of list as { name?: unknown; url?: unknown }[]) {
      if (typeof a.url !== "string" || typeof a.name !== "string") continue;
      let u: URL;
      try {
        u = new URL(a.url);
      } catch {
        continue;
      }
      if (u.protocol !== "https:" || u.hostname !== ATTACHMENT_HOST || u.search || !ATTACHMENT_PATH.test(u.pathname)) {
        continue;
      }
      const seen = byUrl.get(u.href);
      if (seen) {
        if (!seen.postedBy.includes(row.unit)) seen.postedBy.push(row.unit);
        continue;
      }
      byUrl.set(u.href, {
        id: "",
        unit: row.unit,
        postedBy: [row.unit],
        name: a.name.trim().slice(0, 500) || u.pathname.split("/").pop()!,
        url: u.href,
        path: u.pathname,
        ext: u.pathname.split(".").pop()!.toLowerCase(),
        announcementId: row.announcementId,
        announcementTitle: row.title,
        publishedAt: row.publishedAt,
      });
    }
  }
  const out = [...byUrl.values()];
  for (const c of out) {
    c.postedBy.sort();
    c.unit = c.postedBy[0]!;
    c.id = await attachmentId(c.url);
  }
  return out;
}

function record(c: Candidate, doc: Omit<AttachmentDoc, "id" | "unit" | "postedBy" | "name" | "url" | "fileType" | "announcementId" | "announcementTitle" | "publishedAt">): AdapterRecord {
  const payload = AttachmentDocSchema.parse({
    id: c.id,
    unit: c.unit,
    postedBy: c.postedBy,
    name: c.name,
    url: c.url,
    fileType: c.ext === "jpeg" ? "jpg" : c.ext,
    announcementId: c.announcementId,
    announcementTitle: c.announcementTitle,
    publishedAt: c.publishedAt,
    ...doc,
  });
  return {
    id: c.id,
    unit: c.unit,
    payload,
    title: c.name,
    searchText: [c.name, c.announcementTitle, payload.text].join("\n"),
    sourceUrl: c.url,
    publishedAt: c.publishedAt,
  };
}

function step(source: SourceDefinition, c: Candidate): Step {
  return {
    request: { target: c.url, path: c.path, method: "GET" },
    fatal: false,
    async handle(bytes, ctx) {
      const records: AdapterRecord[] = [];
      const rejected: RejectedRecord[] = [];
      const titleForPrivacy = `${c.announcementTitle} ${c.name}`;
      try {
        let doc: Parameters<typeof record>[1];
        if (c.ext === "pdf") {
          const pdf = await pdfText(bytes);
          doc = pdf.scanned
            ? { method: "none", extracted: false, note: "scanned", pages: pdf.pages, text: "" }
            : { method: "pdf", extracted: true, note: null, pages: pdf.pages, text: pdf.text };
        } else if (OFFICE.has(c.ext)) {
          const text = officeText(bytes, c.ext);
          doc = text ? { method: "office", extracted: true, note: null, pages: null, text } : { method: "none", extracted: false, note: "no_text", pages: null, text: "" };
        } else if (IMAGE_MIME[c.ext]) {
          if (!ctx.ai) throw new IngestionError("DEPENDENCY_UNAVAILABLE", "Workers AI binding missing");
          if (bytes.byteLength > MAX_OCR_BYTES) {
            doc = { method: "none", extracted: false, note: "too_large", pages: null, text: "" };
          } else {
            const cfg = source.adapter.kind === "attachments" ? source.adapter : null;
            const text = await ocrImage(ctx.ai, cfg!.ocrModel, bytes, IMAGE_MIME[c.ext]!);
            doc = text ? { method: "ocr", extracted: true, note: null, pages: null, text } : { method: "ocr", extracted: false, note: "no_text", pages: null, text: "" };
          }
        } else {
          doc = { method: "none", extracted: false, note: "unsupported", pages: null, text: "" };
        }
        doc.text = doc.text.slice(0, 300_000);
        // 讀取但不公開：含學生名單、學號等個人資料的附件不寫入正式資料，只記入隔離區（原始檔仍在 R2 可追溯）。
        const privacy = doc.text ? personalDataReason(titleForPrivacy, doc.text, "all") : null;
        if (privacy) rejected.push({ id: c.id, unit: c.unit, reason: privacy, countsTowardDrift: false });
        else records.push(record(c, doc));
      } catch (err) {
        // 檔案壞掉、加密或格式不符：記下原因、只保留檔名與連結，不重試（不算解析器漂移）。
        if (err instanceof IngestionError && err.code === "DEPENDENCY_UNAVAILABLE") throw err;
        const note = (err instanceof IngestionError ? err.code : "PARSE_FAILED").toLowerCase().slice(0, 100);
        try {
          records.push(record(c, { method: "none", extracted: false, note, pages: null, text: "" }));
        } catch (inner) {
          rejected.push({ id: c.id, unit: c.unit, reason: safeMessage(inner), countsTowardDrift: false });
        }
      }
      return { parsed: 1, records, rejected, skipped: 0 };
    },
  };
}

/**
 * 公告附件：每次執行從已收錄公告的附件清單挑出還沒處理的檔案，下載、抽文字或 OCR。
 * 圖片 OCR 另有每次上限；最近失敗的檔案一天內不重試。
 */
export const attachmentsAdapter: Adapter = {
  start() {
    throw new IngestionError("INTERNAL_ERROR", "attachments source must be planned from the database");
  },
  async plan(source, nowIso, store): Promise<Plan> {
    if (source.adapter.kind !== "attachments") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    const cfg = source.adapter;
    const candidates = await attachmentCandidates(await store.announcementAttachments());
    const handled = await store.handledKeys(source.id, source.entityType);
    const failed = await store.recentlyFailedTargets(
      source.id,
      new Date(Date.parse(nowIso) - FAILED_RETRY_MS).toISOString(),
    );
    const pending = candidates.filter((c) => !handled.has(`${c.unit}:${c.id}`) && !failed.has(c.url));
    const batch: Candidate[] = [];
    let images = 0;
    for (const c of pending) {
      if (batch.length >= cfg.maxPerRun) break;
      if (IMAGE_MIME[c.ext]) {
        if (images >= cfg.maxOcrPerRun) continue;
        images++;
      }
      batch.push(c);
    }
    const inBatch = new Set(batch.map((c) => c.id));
    return {
      steps: batch.map((c) => step(source, c)),
      seen: candidates.filter((c) => !inBatch.has(c.id)).map((c) => ({ id: c.id, unit: c.unit })),
      deferred: pending.length - batch.length,
    };
  },
};
