import { IngestionError } from "../shared/errors";
import type { ManualInbox } from "./types";

/** 人工整理檔在 R2 的前綴；與原始檔（raw/）分開，upload-manual 只寫這裡。 */
export const MANUAL_PREFIX = "manual/";

/** 人工整理檔只能放在這兩個資料夾，檔名不得有空白、斜線或「..」。 */
export const MANUAL_PATH = /^(crawler_data|derived)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(md|json)$/;

export function assertManualPath(path: string): void {
  if (!MANUAL_PATH.test(path) || path.includes("..")) {
    throw new IngestionError("URL_NOT_ALLOWED", `manual file path not allowed: ${path}`);
  }
}

export class R2ManualInbox implements ManualInbox {
  constructor(private readonly bucket: R2Bucket) {}

  async get(path: string) {
    assertManualPath(path);
    const object = await this.bucket.get(`${MANUAL_PREFIX}${path}`);
    if (!object) return null;
    return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType ?? null };
  }
}
