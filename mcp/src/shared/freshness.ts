export type FreshnessState = "fresh" | "stale" | "never_ingested";

export function freshnessOf(lastSuccessAt: string | null, maxStalenessSeconds: number, nowIso: string): FreshnessState {
  if (!lastSuccessAt) return "never_ingested";
  const age = (Date.parse(nowIso) - Date.parse(lastSuccessAt)) / 1000;
  return age > maxStalenessSeconds ? "stale" : "fresh";
}
