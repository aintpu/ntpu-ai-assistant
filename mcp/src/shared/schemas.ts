import { z } from "zod";

/** 公告的 canonical 形式：只保留官網原文與可驗證的欄位，不推論任何事實。 */
export const AttachmentSchema = z
  .object({
    name: z.string().min(1).max(500),
    url: z.string().url().max(2000),
  })
  .strict();

export const AnnouncementSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{24}$/),
    unit: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    title: z.string().min(1).max(500),
    publishedAt: z.string().datetime(),
    bodyText: z.string().max(200_000),
    attachments: z.array(AttachmentSchema).max(200),
    sourceUrl: z.string().url().max(2000),
  })
  .strict();

export type Announcement = z.infer<typeof AnnouncementSchema>;

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
