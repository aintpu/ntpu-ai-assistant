import { IngestionError } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { FaqSchema, RegulationSchema, type Faq, type Regulation } from "../../shared/schemas";
import {
  gregorianDateIso,
  normalizeTitle,
  parseCatalogFile,
  parseFaqMarkdown,
  parseRegulationsMarkdown,
  singleUrl,
  splitKeywords,
  type CatalogRow,
} from "../manual-parse";
import type { SourceDefinition } from "../types";
import type { Adapter, AdapterRecord, RejectedRecord, Step, StepOutcome } from "./types";
import { decodeUtf8 } from "./types";

/** 沒有官方連結的資料，provenance 指向 repo 上的原始檔，仍可追溯。 */
export const REPO_BLOB_BASE = "https://github.com/aintpu/ntpu-ai-assistant/blob/main/";

export function repoFileUrl(path: string): string {
  return REPO_BLOB_BASE + path.split("/").map(encodeURIComponent).join("/");
}

/** 彙整表的「所屬單位／處室」對應到處室代碼；學院、研究中心等沒有代碼的歸為 academic。 */
export const OWNER_UNITS: Record<string, string> = {
  秘書室: "os",
  教務處: "oaa",
  學生事務處: "osa",
  總務處: "oga",
  研究發展處: "ord",
  國際事務處: "oia",
  圖書館: "library",
  體育室: "ope",
  人事室: "op",
  主計室: "oa",
  資訊中心: "cic",
  進修暨推廣部: "eec",
  校友中心: "alumni",
  高等教育深耕計畫辦公室: "edusp",
  通識教育中心: "cge",
  語言中心: "lc",
};

export function ownerUnit(owner: string): string {
  return OWNER_UNITS[owner] ?? "academic";
}

async function shortId(...parts: string[]): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(parts.join("\u0000")))).slice(0, 24);
}

function parseText(bytes: Uint8Array): string {
  try {
    return decodeUtf8(bytes);
  } catch (err) {
    throw new IngestionError("PARSE_FAILED", `file is not valid UTF-8: ${(err as Error).message}`);
  }
}

function parseCatalogBytes(bytes: Uint8Array): CatalogRow[] {
  try {
    return parseCatalogFile(JSON.parse(parseText(bytes))).rows;
  } catch (err) {
    if (err instanceof IngestionError) throw err;
    throw new IngestionError("PARSE_FAILED", `catalog is not valid: ${(err as Error).message}`);
  }
}

function fileStep(source: SourceDefinition, path: string, handle: Step["handle"], fatal = true): Step {
  if (!source.entrypoints.includes(path)) {
    throw new IngestionError("URL_NOT_ALLOWED", `file is not registered for ${source.id}: ${path}`);
  }
  return { request: { target: path, path, method: "GET" }, fatal, handle };
}

function regulationRecord(r: Regulation): AdapterRecord {
  return {
    id: r.id,
    unit: r.unit,
    payload: r,
    title: r.title,
    searchText: [r.title, r.owner, r.tags.join(" "), r.bodyText].join("\n"),
    sourceUrl: r.sourceUrl,
    publishedAt: gregorianDateIso(r.updatedDate),
  };
}

function validateRegulation(candidate: Regulation, rejected: RejectedRecord[], records: AdapterRecord[]): void {
  const parsed = RegulationSchema.safeParse(candidate);
  if (parsed.success) {
    records.push(regulationRecord(parsed.data));
  } else {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    rejected.push({ id: candidate.id || "(no id)", unit: candidate.unit, reason: `invalid: ${fields}`, countsTowardDrift: true });
  }
}

/** 彙整表裡只有目錄的一列 → 法規（沒有全文）。沒有任何連結的列（例如「尚無可用法規資料」）不收錄。 */
async function catalogOnly(row: CatalogRow, unit: string): Promise<Regulation | null> {
  const sourceUrl = row.fileUrl ?? row.sourcePage;
  if (!row.title || !row.owner || !sourceUrl) return null;
  return {
    id: await shortId("catalog", row.owner, normalizeTitle(row.title), row.fileUrl ?? row.sourcePage ?? ""),
    unit,
    owner: row.owner,
    title: row.title,
    bodyText: "",
    hasFullText: false,
    fileUrl: row.fileUrl,
    tags: row.tags,
    updatedDate: row.updatedDate,
    sourceUrl,
    sourceFile: row.sourceFile,
  };
}

/**
 * 一個處室的法規：先讀彙整表，再讀全文檔，以正規化標題配對補上官方連結與標籤。
 * 彙整表有、全文檔沒有的法規也收錄（只有目錄）。
 */
export const manualRegulationsAdapter: Adapter = {
  start(source) {
    const cfg = source.adapter;
    if (cfg.kind !== "manual-regulations") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    return [
      fileStep(source, cfg.catalogFile, async (catalogBytes) => {
        const owned = parseCatalogBytes(catalogBytes).filter((r) => cfg.catalogOwners.includes(r.owner));
        const fullText = fileStep(source, cfg.fullTextFile, async (bytes) => {
          const docs = parseRegulationsMarkdown(parseText(bytes));
          if (docs.length === 0) throw new IngestionError("PARSER_DRIFT", "no regulations found in full-text file");
          const byTitle = new Map<string, CatalogRow[]>();
          for (const row of owned) {
            const key = normalizeTitle(row.title);
            byTitle.set(key, [...(byTitle.get(key) ?? []), row]);
          }
          const matched = new Set<CatalogRow>();
          const records: AdapterRecord[] = [];
          const rejected: RejectedRecord[] = [];
          for (const doc of docs) {
            const key = normalizeTitle(doc.title);
            const match = (byTitle.get(key) ?? []).find((r) => !matched.has(r));
            if (match) matched.add(match);
            const fileUrl = doc.fileUrl ?? match?.fileUrl ?? null;
            validateRegulation(
              {
                id: await shortId("regulation", source.sourceUnit, key, String(doc.occurrence)),
                unit: source.sourceUnit,
                owner: cfg.catalogOwners[0]!,
                title: doc.title,
                bodyText: doc.bodyText,
                hasFullText: doc.bodyText.length > 0,
                fileUrl,
                tags: [...new Set([...doc.tags, ...(match?.tags ?? [])])].slice(0, 30),
                updatedDate: doc.uploadDate ?? match?.updatedDate ?? null,
                sourceUrl: fileUrl ?? repoFileUrl(cfg.fullTextFile),
                sourceFile: cfg.fullTextFile,
              },
              rejected,
              records,
            );
          }
          let skipped = 0;
          const ids = new Set(records.map((r) => r.id));
          for (const row of owned) {
            if (matched.has(row)) continue;
            const reg = await catalogOnly(row, source.sourceUnit);
            // 沒有任何連結，或與已收錄的目錄列完全相同（同單位、標題、連結）：不重複收錄。
            if (!reg || ids.has(reg.id)) {
              skipped++;
              continue;
            }
            ids.add(reg.id);
            validateRegulation(reg, rejected, records);
          }
          const outcome: StepOutcome = {
            parsed: docs.length + owned.length - matched.size,
            records,
            rejected,
            skipped,
            listComplete: true,
          };
          return outcome;
        });
        return { parsed: 0, records: [], rejected: [], skipped: 0, next: [fullText] };
      }),
    ];
  },
};

/** 彙整表裡其餘單位（沒有全文檔）的法規目錄。 */
export const manualRegulationCatalogAdapter: Adapter = {
  start(source) {
    const cfg = source.adapter;
    if (cfg.kind !== "manual-regulation-catalog") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    return [
      fileStep(source, cfg.catalogFile, async (bytes) => {
        const rows = parseCatalogBytes(bytes);
        if (rows.length === 0) throw new IngestionError("PARSER_DRIFT", "catalog has no rows");
        const records: AdapterRecord[] = [];
        const rejected: RejectedRecord[] = [];
        let skipped = 0;
        const keys = new Set<string>();
        for (const row of rows) {
          if (cfg.excludeOwners.includes(row.owner)) {
            skipped++;
            continue;
          }
          const reg = await catalogOnly(row, ownerUnit(row.owner));
          // 沒有任何連結，或與已收錄的目錄列完全相同（同單位、標題、連結）：不重複收錄。
          if (!reg || keys.has(`${reg.unit}:${reg.id}`)) {
            skipped++;
            continue;
          }
          keys.add(`${reg.unit}:${reg.id}`);
          validateRegulation(reg, rejected, records);
        }
        return { parsed: rows.length, records, rejected, skipped, listComplete: true };
      }),
    ];
  },
};

const FAQ_ID = /^[A-Za-z0-9-]{3,64}$/;

/**
 * 各處室常見問答：每個檔案一步。某個處室的檔案讀不到時，其他處室照樣更新（步驟不是 fatal）；
 * 但只有全部檔案都讀到，才算完整走完（listComplete）——否則讀不到的處室的 FAQ 會被當成
 * 從檔案消失，連續幾次後被標為 inactive。
 */
export const manualFaqAdapter: Adapter = {
  start(source) {
    const cfg = source.adapter;
    if (cfg.kind !== "manual-faq") throw new IngestionError("INTERNAL_ERROR", "wrong adapter");
    if (cfg.files.length === 0) throw new IngestionError("URL_NOT_ALLOWED", `no FAQ files for ${source.id}`);
    let handled = 0;
    return cfg.files.map(({ file, unit }) =>
      fileStep(source, file, async (bytes) => {
        const entries = parseFaqMarkdown(parseText(bytes));
        if (entries.length === 0) throw new IngestionError("PARSER_DRIFT", `no FAQ entries in ${file}`);
        const records: AdapterRecord[] = [];
        const rejected: RejectedRecord[] = [];
        const ids = new Set<string>();
        for (const entry of entries) {
          const given = (entry.fields["FAQ 編號"] ?? "").trim();
          // 人事室的檔案沒有 FAQ 編號：用問題文字產生穩定編號（問題改字就視為新的一題）。
          const id = FAQ_ID.test(given) ? given : `${unit}-q-${(await shortId("faq", unit, entry.question)).slice(0, 12)}`;
          if (ids.has(id)) {
            rejected.push({ id, unit, reason: "duplicate FAQ id in file", countsTowardDrift: true });
            continue;
          }
          ids.add(id);
          const sourceDate = (entry.fields["來源日期"] ?? "").trim();
          const candidate: Faq = {
            id,
            unit,
            question: entry.question,
            answer: entry.answer,
            topic: entry.fields["業務主題"]?.trim() || null,
            division: entry.fields["承辦組別"]?.trim() || null,
            sourceDate: /^\d{4}-\d{2}-\d{2}$/.test(sourceDate) ? sourceDate : null,
            keywords: splitKeywords(entry.fields["關鍵字"]),
            details: entry.details.slice(0, 10_000),
            sourceUrl: singleUrl(entry.fields["來源網址"]) ?? repoFileUrl(file),
            sourceFile: file,
          };
          const parsed = FaqSchema.safeParse(candidate);
          if (!parsed.success) {
            const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
            rejected.push({ id, unit, reason: `invalid: ${fields}`, countsTowardDrift: true });
            continue;
          }
          const f = parsed.data;
          records.push({
            id: f.id,
            unit: f.unit,
            payload: f,
            title: f.question,
            searchText: [f.question, f.answer, f.topic ?? "", f.division ?? "", f.keywords.join(" ")].join("\n"),
            sourceUrl: f.sourceUrl,
            publishedAt: gregorianDateIso(f.sourceDate),
          });
        }
        handled++;
        return {
          parsed: entries.length,
          records,
          rejected,
          skipped: 0,
          // 步驟依序執行：最後一個檔案處理時，handled 等於檔案數就代表前面每個檔案都讀到了。
          listComplete: handled === cfg.files.length,
        };
      }, false),
    );
  },
};
