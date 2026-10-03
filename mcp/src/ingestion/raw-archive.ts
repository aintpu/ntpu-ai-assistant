import { IngestionError } from "../shared/errors";
import type { ArchivedRawSnapshot, RawArchive, RawSnapshot } from "./types";

export function rawObjectKey(snapshot: Pick<RawSnapshot, "sourceId" | "fetchedAt" | "rawHash">): string {
  const [yyyy, mm, dd] = snapshot.fetchedAt.slice(0, 10).split("-");
  return `raw/${snapshot.sourceId}/${yyyy}/${mm}/${dd}/${snapshot.rawHash}`;
}

/**
 * R2 原始檔存放（規格 06 §9）。同一天內內容相同的回應共用同一個物件；
 * 物件寫入後不再覆寫，每次抓取另外記在 ingestion_items。
 */
export class R2RawArchive implements RawArchive {
  constructor(private readonly bucket: R2Bucket) {}

  async put(snapshot: RawSnapshot): Promise<ArchivedRawSnapshot> {
    const key = rawObjectKey(snapshot);
    try {
      const existing = await this.bucket.head(`${key}.bin`);
      if (!existing) {
        await this.bucket.put(`${key}.bin`, snapshot.bytes, {
          httpMetadata: { contentType: snapshot.contentType ?? "application/octet-stream" },
          sha256: snapshot.rawHash,
        });
        const meta = {
          sourceId: snapshot.sourceId,
          requestedUrl: snapshot.requestedUrl,
          finalUrl: snapshot.finalUrl,
          fetchedAt: snapshot.fetchedAt,
          httpStatus: snapshot.httpStatus,
          contentType: snapshot.contentType,
          headers: snapshot.headers,
          requestBody: snapshot.requestBody,
          byteSize: snapshot.bytes.byteLength,
          rawHash: snapshot.rawHash,
        };
        await this.bucket.put(`${key}.meta.json`, JSON.stringify(meta, null, 2), {
          httpMetadata: { contentType: "application/json" },
        });
      }
    } catch (err) {
      throw new IngestionError("RAW_ARCHIVE_FAILED", `raw archive failed: ${(err as Error).message}`);
    }
    return { key: `${key}.bin`, rawHash: snapshot.rawHash };
  }
}
