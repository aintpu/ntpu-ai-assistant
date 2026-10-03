export type IngestionErrorCode =
  | "SOURCE_NOT_REGISTERED"
  | "SOURCE_DISABLED"
  | "URL_NOT_ALLOWED"
  | "SSRF_BLOCKED"
  | "FETCH_TIMEOUT"
  | "FETCH_TOO_LARGE"
  | "FETCH_HTTP_ERROR"
  | "CONTENT_TYPE_REJECTED"
  | "REDIRECT_REJECTED"
  | "RAW_ARCHIVE_FAILED"
  | "PARSE_FAILED"
  | "NORMALIZE_FAILED"
  | "VALIDATION_FAILED"
  | "PARSER_DRIFT"
  | "PUBLISH_FAILED"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class IngestionError extends Error {
  constructor(
    readonly code: IngestionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IngestionError";
  }
}

export function errorCodeOf(err: unknown): IngestionErrorCode {
  return err instanceof IngestionError ? err.code : "INTERNAL_ERROR";
}

/** 錯誤訊息寫進 DB／log 前截斷，避免把整份回應內容帶出去。 */
export function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 500);
}
