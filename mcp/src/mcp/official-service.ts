import type { AnnouncementRow, ReadRepository } from "../db/read-repository";
import { OfficialSchema, type Official, type Provenance } from "../shared/schemas";
import { provenanceOf } from "./announcement-service";

export interface OfficialItem extends Official {
  provenance: Provenance;
}

function parse(row: AnnouncementRow): Official | null {
  try {
    const parsed = OfficialSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 比對用：小寫、去掉標點（DR. DALTON DAW-TUNG, LIN → dr dalton daw tung lin）。 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * 與關鍵字的相符程度（0 = 不符）。中文比對姓名、職務；英文以單字比對、詞序不拘
 * （Daw-Tung Lin、Lin Daw-Tung 都算），也比對英文職稱的常見說法。
 * 查詢只保留分數最高的紀錄：「學術副校長」不會連帶列出「校長」。
 */
export function matchScore(o: Official, keyword: string): number {
  const k = keyword.trim();
  if (!k) return 1;
  let best = 0;
  if (o.name && (o.name.includes(k) || k.includes(o.name))) best = 1000;
  if (o.title.includes(k)) best = Math.max(best, 100 + k.length);
  else if (k.includes(o.title)) best = Math.max(best, 100 + o.title.length);
  const kw = words(k);
  for (const candidate of [o.nameEn, o.nameEnOfficial, ...o.titleEnSearch]) {
    if (!candidate || kw.length === 0) continue;
    const cw = [...new Set(words(candidate).filter((w) => w !== "dr"))];
    if (cw.length === 0) continue;
    const isName = candidate !== o.titleEnSearch.find((t) => t === candidate);
    // 提問含這個名字或職稱的每一個字，或提問的每一個字都在名字裡（例如只打 Velema）
    if (cw.every((w) => kw.includes(w)) || (isName && kw.every((w) => cw.includes(w)))) {
      best = Math.max(best, isName ? 1000 : 100 + cw.length);
    }
  }
  return best;
}

/** 現任主管的唯讀查詢。只回傳最近一次抓取時姓名仍載明在官方頁面上的紀錄（status=active）。 */
export class OfficialService {
  constructor(private readonly repo: ReadRepository) {}

  async list(input: { keyword?: string; unit?: string }): Promise<OfficialItem[]> {
    const rows = await this.repo.listActive("official", input.unit);
    const scored: { item: OfficialItem; score: number }[] = [];
    for (const row of rows) {
      const o = parse(row);
      if (!o) continue;
      const score = input.keyword ? matchScore(o, input.keyword) : 1;
      if (score > 0) scored.push({ item: { ...o, provenance: provenanceOf(row) }, score });
    }
    const top = Math.max(0, ...scored.map((s) => s.score));
    return scored.filter((s) => s.score === top).map((s) => s.item);
  }
}
