import type { SourceDefinition, SourceRequest } from "../types";

/** adapter 正規化並通過 schema 驗證後的一筆資料。id 是來源給的編號（同一來源內唯一）。 */
export interface AdapterRecord {
  id: string;
  payload: unknown;
  title: string;
  searchText: string;
  sourceUrl: string;
  publishedAt: string | null;
}

export interface RejectedRecord {
  id: string;
  reason: string;
  /** 驗證失敗才算進 drift 比例；依規則排除的（例如個人資料）不算。 */
  countsTowardDrift: boolean;
}

/** 資料庫裡已有的版本（或隔離區裡的紀錄），用來決定 HTML 來源要不要重抓內文。 */
export interface KnownRecord {
  title: string | null;
  publishedAt: string | null;
  verifiedAt: string;
}

export interface StepContext {
  source: SourceDefinition;
  nowIso: string;
  /** 在這個時間之前驗證過的紀錄都要重新驗證（ISO 時間）。 */
  reverifyBefore?: string;
  /** 依來源編號查已知紀錄。 */
  known(ids: string[]): Promise<Map<string, KnownRecord>>;
  activeCount(): Promise<number>;
}

export interface StepOutcome {
  parsed: number;
  records: AdapterRecord[];
  rejected: RejectedRecord[];
  /** 依來源規則排除、本來就不是資料的項目（例如首頁輪播 banner、連到外部網站的列表項目）。 */
  skipped: number;
  /** 接下來要抓的請求（下一頁、內文頁）。 */
  next?: Step[];
  /** 這次在來源列表上看到、但沒有重抓內文的編號（仍存在，不算消失）。 */
  seenIds?: string[];
  /** 已經走完整個列表；只有走完才判斷哪些資料從來源消失。 */
  listComplete?: boolean;
  /** 需要重抓但超過單次上限、留到下一次的內文數。 */
  deferred?: number;
}

export interface Step {
  request: SourceRequest;
  /** 列表頁失敗就停止（後面的頁面依賴它）；內文頁失敗只影響那一則。 */
  fatal: boolean;
  handle(bytes: Uint8Array, ctx: StepContext): Promise<StepOutcome>;
}

export interface Adapter {
  start(source: SourceDefinition, nowIso: string): Step[];
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
