import type { Clock } from "../../src/shared/clock";
import type { ArchivedRawSnapshot, RawArchive, RawSnapshot } from "../../src/ingestion/types";
import { rawObjectKey } from "../../src/ingestion/raw-archive";

export interface FakePublication {
  _id: string;
  type: string;
  title: string;
  publishAt: string;
  content: string;
  files: { name: string; url: string }[];
}

export function publication(n: number, overrides: Partial<FakePublication> = {}): FakePublication {
  return {
    _id: n.toString(16).padStart(24, "0"),
    type: "typical",
    title: `研發處公告 ${n}`,
    publishAt: new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString(),
    content: `<p>第 ${n} 則公告內文。</p><p>請於期限內申請&nbsp;計畫。</p>`,
    files: [{ name: `附件${n}.pdf`, url: `/uploads/file_${n}.pdf` }],
    ...overrides,
  };
}

export function section(n: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: (0xc0 + n).toString(16).padStart(24, "0"),
    name,
    title: `頁面 ${name}`,
    content: `<p>${name} 的介紹內文。</p><p><a href="/educational-philosophy">治校理念</a></p>`,
    updatedAt: "2026-09-04T03:00:00.000Z",
    editors: "someone@gm.ntpu.edu.tw",
    ...overrides,
  };
}

export const DEFAULT_SECTIONS: Record<string, unknown> = {
  "/president": section(1, "/president", { title: "校長", content: "<p>校長簡介：致力推動永續發展。</p>" }),
  "/educational-philosophy": section(2, "/educational-philosophy", { title: "治校理念" }),
  "/vice-president-academic": section(3, "/vice-president-academic", { title: "學術副校長" }),
  "/vice-president-administration": section(4, "/vice-president-administration", { title: "行政副校長" }),
  "/vice-president-financial": section(5, "/vice-president-financial", { title: "財務暨永續發展副校長" }),
};

/** 依主機分流：學校 API 交給 FakeStrapi，圖書館與語言中心交給 FakeSites。 */
export function routedFetch(strapi: { fetch: (r: Request) => Promise<Response> }, sites: { fetch: (r: Request) => Promise<Response> }) {
  return (request: Request) =>
    new URL(request.url).hostname === "api-carrier.ntpu.edu.tw" ? strapi.fetch(request) : sites.fetch(request);
}

export function strapiBody(items: unknown[]): string {
  return JSON.stringify({ data: { publications: items } });
}

/**
 * 模擬 strapi：依請求裡的 start 回傳對應的那一頁，並記錄所有收到的請求。
 * 有 bySite 時依 site key 回傳各處室自己的公告（沒列到的處室沒有公告）。
 */
export class FakeStrapi {
  requests: Request[] = [];
  bodies: string[] = [];
  constructor(
    public items: unknown[],
    public bySite?: Record<string, unknown[]>,
    /** 內容頁（sections），依頁面路徑。 */
    public sections: Record<string, unknown> = DEFAULT_SECTIONS,
  ) {}

  fetch = async (request: Request): Promise<Response> => {
    this.requests.push(request);
    const body = await request.text();
    this.bodies.push(body);
    if (body.includes("sections(")) {
      const names = [...body.matchAll(/\\"(\/[a-z0-9/-]+)\\"/g)].map((m) => m[1]!);
      const found = names.flatMap((n) => (this.sections[n] ? [this.sections[n]] : []));
      return new Response(JSON.stringify({ data: { sections: found } }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const start = Number(/start:(\d+)/.exec(body)?.[1] ?? 0);
    const limit = Number(/limit:(\d+)/.exec(body)?.[1] ?? 100);
    const site = /sitesApproved_in:\\?"([a-z_]+)/.exec(body)?.[1] ?? "";
    const items = this.bySite ? (this.bySite[site] ?? []) : this.items;
    return new Response(strapiBody(items.slice(start, start + limit)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
}

export class MemoryRawArchive implements RawArchive {
  objects = new Map<string, RawSnapshot>();
  fail = false;

  async put(snapshot: RawSnapshot): Promise<ArchivedRawSnapshot> {
    if (this.fail) throw new Error("R2 unavailable");
    const key = `${rawObjectKey(snapshot)}.bin`;
    if (!this.objects.has(key)) this.objects.set(key, snapshot);
    return { key, rawHash: snapshot.rawHash };
  }
}

export class FixedClock implements Clock {
  constructor(public now = "2026-10-03T00:00:00.000Z") {}
  nowIso() {
    return this.now;
  }
  advance(seconds: number) {
    this.now = new Date(Date.parse(this.now) + seconds * 1000).toISOString();
  }
}
