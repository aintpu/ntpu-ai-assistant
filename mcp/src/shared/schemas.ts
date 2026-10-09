import { z } from "zod";

/** 公告的 canonical 形式：只保留官網原文與可驗證的欄位，不推論任何事實。 */
export const AttachmentSchema = z
  .object({
    name: z.string().min(1).max(500),
    url: z.string().url().max(2000),
  })
  .strict();

/** 來源給的公告／頁面編號：Strapi _id（24 hex）、圖書館 cntId（32 hex）、語言中心 np_no（NP + 數字）。 */
export const RecordIdSchema = z.string().regex(/^[A-Za-z0-9]{8,64}$/);
export const UnitSchema = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

export const AnnouncementSchema = z
  .object({
    id: RecordIdSchema,
    unit: UnitSchema,
    title: z.string().min(1).max(500),
    publishedAt: z.string().datetime(),
    bodyText: z.string().max(200_000),
    attachments: z.array(AttachmentSchema).max(200),
    sourceUrl: z.string().url().max(2000),
  })
  .strict();

export type Announcement = z.infer<typeof AnnouncementSchema>;

/** 處室的固定內容頁（例如校長室介紹）。links 是內文裡的連結，原樣保留。 */
export const PageSchema = z
  .object({
    id: RecordIdSchema,
    unit: UnitSchema,
    // 招生頁等路徑含中文與括號（例如 /admission/碩士班一般入學）；不允許空白、引號、角括號與反斜線。
    path: z.string().regex(/^\/[^\s"'<>\\]{1,200}$/u),
    title: z.string().min(1).max(500),
    updatedAt: z.string().datetime(),
    bodyText: z.string().min(1).max(200_000),
    links: z.array(AttachmentSchema).max(500),
    sourceUrl: z.string().url().max(2000),
  })
  .strict();

export type Page = z.infer<typeof PageSchema>;

/** 公告附件的內容（抽出的文字或 OCR 結果）。extracted=false 表示只有檔名與連結（例如掃描檔，待 OCR）。 */
export const AttachmentDocSchema = z
  .object({
    id: RecordIdSchema,
    unit: UnitSchema,
    postedBy: z.array(UnitSchema).min(1).max(30),
    name: z.string().min(1).max(500),
    url: z.string().url().max(2000),
    fileType: z.string().regex(/^[a-z0-9]{2,5}$/),
    announcementId: z.string().min(1).max(100),
    announcementTitle: z.string().min(1).max(500),
    publishedAt: z.string().datetime().nullable(),
    method: z.enum(["pdf", "office", "ocr", "none"]),
    extracted: z.boolean(),
    /** 沒有抽出內容的原因，例如 scanned、too_large、unsupported、no_text。 */
    note: z.string().max(100).nullable(),
    pages: z.number().int().nonnegative().nullable(),
    text: z.string().max(300_000),
  })
  .strict();

export type AttachmentDoc = z.infer<typeof AttachmentDocSchema>;

/** 人工整理檔在 repo 裡的路徑，例如 crawler_data/oaa_regulations.md。 */
const SourceFileSchema = z.string().regex(/^crawler_data\/[^\s/]{1,200}$/);

/**
 * 法規。來自人工整理的全文檔（同學自官方 PDF 轉出的文字）與法規彙整表（只有目錄、沒有全文）。
 * 文字照原檔保留，不改寫、不推論；updatedDate 保留原表格寫法（有 MM/DD/YYYY、民國年等多種格式）。
 */
export const RegulationSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{24}$/),
    unit: UnitSchema,
    /** 所屬單位的原文名稱，例如「學生事務處」「法律學院」。 */
    owner: z.string().min(1).max(100),
    title: z.string().min(1).max(500),
    /** 沒有全文（只在彙整表出現）時為空字串。 */
    bodyText: z.string().max(300_000),
    hasFullText: z.boolean(),
    /** 官方檔案連結；全文檔沒寫、彙整表也配對不到時為 null。 */
    fileUrl: z.string().url().max(2000).nullable(),
    tags: z.array(z.string().min(1).max(100)).max(30),
    updatedDate: z.string().max(40).nullable(),
    /** 官方連結；沒有就是 null（不另外指向 repo 等非官方網址）。 */
    sourceUrl: z.string().url().max(2000).nullable(),
    sourceFile: SourceFileSchema,
  })
  .strict();

export type Regulation = z.infer<typeof RegulationSchema>;

/** 各處室提供的常見問答（人工整理檔）。回答照原檔保留；details 是原檔的其餘欄位（承辦組別、聯絡窗口等）。 */
export const FaqSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9-]{3,64}$/),
    unit: UnitSchema,
    question: z.string().min(1).max(1000),
    answer: z.string().min(1).max(50_000),
    topic: z.string().max(200).nullable(),
    division: z.string().max(200).nullable(),
    sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    keywords: z.array(z.string().min(1).max(100)).max(50),
    details: z.string().max(10_000),
    /** 原檔的來源網址；沒有就是 null。 */
    sourceUrl: z.string().url().max(2000).nullable(),
    sourceFile: SourceFileSchema,
  })
  .strict();

export type Faq = z.infer<typeof FaqSchema>;

/**
 * 現任主管。姓名、職務、任期來自人工核對的對照表，每次抓取都確認中文姓名仍載明在官方主管介紹頁上。
 * 英文姓名只採用官網英文頁寫明的寫法；英文頁待補或未更新時為 null，不自行以拼音補上。
 * 任期只在頁面寫明時才有值。
 */
export const OfficialSchema = z
  .object({
    id: RecordIdSchema,
    unit: UnitSchema,
    title: z.string().min(1).max(100),
    /** 官網沒有中文姓名時為 null（例如國際長）。 */
    name: z.string().min(1).max(50).nullable(),
    /** 統一寫法（名-名 姓），方便比對。 */
    nameEn: z.string().min(1).max(100).nullable(),
    /** 官網英文頁原本的寫法，例如 DR. DALTON DAW-TUNG, LIN。 */
    nameEnOfficial: z.string().min(1).max(100).nullable(),
    /** 英文職稱的常見說法，只供比對英文提問，不是官方頭銜。 */
    titleEnSearch: z.array(z.string().min(1).max(100)).max(10),
    term: z.string().max(50).nullable(),
    /** 任期的出處原文。 */
    termSource: z.string().max(200).nullable(),
    note: z.string().max(200).nullable(),
    path: z.string().regex(/^\/[a-z0-9][a-z0-9/-]{0,100}$/),
    pageTitle: z.string().max(500),
    /** 官方頁面最後修改時間（學校 API 的 updatedAt）。 */
    pageUpdatedAt: z.string().datetime(),
    sourceUrl: z.string().url().max(2000),
  })
  .strict();

export type Official = z.infer<typeof OfficialSchema>;

export const ProvenanceSchema = z
  .object({
    sourceId: z.string(),
    sourceUnit: z.string(),
    /** 官方來源網址。人工整理檔沒有官方連結時為 null，請改用文字標示來源，不要自行補連結。 */
    sourceUrl: z.string().url().nullable(),
    sourceType: z.string(),
    trustLevel: z.string(),
    version: z.number().int().positive(),
    publishedAt: z.string().nullable(),
    verifiedAt: z.string(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type Provenance = z.infer<typeof ProvenanceSchema>;
