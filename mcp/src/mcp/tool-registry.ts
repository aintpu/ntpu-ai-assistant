/**
 * MCP 工具登記表（規格 07 §10、§1）。
 * 每個對外工具都必須在這裡登記；createMcpServer 只註冊登記過、且符合公開 v1 政策的工具：
 * risk R0、data class L0、read-only、不需要 scope（規格 08 §2）。
 * 工具名稱、說明或 schema 有變動時，contract snapshot 測試會失敗，需要審查後更新快照（規格 10 §7）。
 */

export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";
export type DataClass = "L0" | "L1" | "L2" | "L3" | "L4";

export interface ToolRegistryEntry {
  name: string;
  /** 工具契約版本（SemVer）；名稱、說明、schema、語意改變時調整。 */
  version: string;
  owner: string;
  dataOwner: string;
  riskLevel: RiskLevel;
  readOnly: boolean;
  maximumDataClass: DataClass;
  requiredScopes: string[];
  reviewedAt: string;
}

const OWNER = "盧信廷";
const OFFICIAL = "盧信廷（內容由各處室官網發布）";
const MANUAL = "盧信廷（人工整理檔維護者；FAQ 原始內容由各處室提供）";

function entry(name: string, dataOwner: string): ToolRegistryEntry {
  return {
    name,
    version: "1.0.0",
    owner: OWNER,
    dataOwner,
    riskLevel: "R0",
    readOnly: true,
    maximumDataClass: "L0",
    requiredScopes: [],
    reviewedAt: "2026-10-04",
  };
}

export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  entry("search_announcements", OFFICIAL),
  entry("get_announcement", OFFICIAL),
  entry("search_pages", OFFICIAL),
  entry("get_page", OFFICIAL),
  entry("search_regulations", MANUAL),
  entry("get_regulation", MANUAL),
  entry("search_faqs", MANUAL),
  entry("get_faq", MANUAL),
];

/** 公開 v1 政策（規格 07 §10）：登記過、R0、L0、唯讀、不需要 scope → 允許。 */
export function isAllowedPublicTool(name: string): boolean {
  const e = TOOL_REGISTRY.find((t) => t.name === name);
  return (
    e !== undefined &&
    e.riskLevel === "R0" &&
    e.maximumDataClass === "L0" &&
    e.readOnly &&
    e.requiredScopes.length === 0
  );
}

export function registryEntry(name: string): ToolRegistryEntry {
  const e = TOOL_REGISTRY.find((t) => t.name === name);
  if (!e) throw new Error(`tool is not registered: ${name}`);
  return e;
}
