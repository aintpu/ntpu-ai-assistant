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
    path: z.string().regex(/^\/[a-z0-9][a-z0-9/-]{0,100}$/),
    title: z.string().min(1).max(500),
    updatedAt: z.string().datetime(),
    bodyText: z.string().min(1).max(200_000),
    links: z.array(AttachmentSchema).max(500),
    sourceUrl: z.string().url().max(2000),
  })
  .strict();

export type Page = z.infer<typeof PageSchema>;

export const ProvenanceSchema = z
  .object({
    sourceId: z.string(),
    sourceUnit: z.string(),
    sourceUrl: z.string().url(),
    sourceType: z.string(),
    trustLevel: z.string(),
    version: z.number().int().positive(),
    publishedAt: z.string().nullable(),
    verifiedAt: z.string(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type Provenance = z.infer<typeof ProvenanceSchema>;
