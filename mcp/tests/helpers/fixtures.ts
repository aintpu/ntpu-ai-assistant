import type { Clock } from "../../src/shared/clock";
import type { ArchivedRawSnapshot, RawArchive, RawSnapshot } from "../../src/ingestion/types";
import { rawObjectKey } from "../../src/ingestion/raw-archive";

export interface FakePublication {
  _id: string;
  title: string;
  publishAt: string;
  content: string;
  files: { name: string; url: string }[];
}

export function publication(n: number, overrides: Partial<FakePublication> = {}): FakePublication {
  return {
    _id: n.toString(16).padStart(24, "0"),
    title: `研發處公告 ${n}`,
    publishAt: new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString(),
    content: `<p>第 ${n} 則公告內文。</p><p>請於期限內申請&nbsp;計畫。</p>`,
    files: [{ name: `附件${n}.pdf`, url: `/uploads/file_${n}.pdf` }],
    ...overrides,
  };
}

export function strapiBody(items: unknown[]): string {
  return JSON.stringify({ data: { publications: items } });
}

/** 模擬 strapi：依請求裡的 start 回傳對應的那一頁，並記錄所有收到的請求。 */
export class FakeStrapi {
  requests: Request[] = [];
  bodies: string[] = [];
  constructor(public items: unknown[]) {}

  fetch = async (request: Request): Promise<Response> => {
    this.requests.push(request);
    const body = await request.text();
    this.bodies.push(body);
    const start = Number(/start:(\d+)/.exec(body)?.[1] ?? 0);
    const limit = Number(/limit:(\d+)/.exec(body)?.[1] ?? 100);
    return new Response(strapiBody(this.items.slice(start, start + limit)), {
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
