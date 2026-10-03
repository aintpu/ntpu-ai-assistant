import { CanonicalStore } from "../db/canonical-store";
import { systemClock } from "../shared/clock";
import { R2RawArchive } from "./raw-archive";
import { runIngestion } from "./run-ingestion";
import { assertRegistryValid } from "./source-registry";

export interface IngestEnv {
  DB: D1Database;
  RAW: R2Bucket;
  ENVIRONMENT: string;
}

assertRegistryValid();

/**
 * 抓取 Worker：只有排程入口，沒有任何公開的 HTTP 觸發點（避免被當成任意抓取服務）。
 * 本機測試用 `npm run dev:ingest` 後打 /__scheduled。
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: IngestEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runIngestion(
        {
          store: new CanonicalStore(env.DB),
          archive: new R2RawArchive(env.RAW),
          fetch: (request) => fetch(request),
          clock: systemClock,
          environment: env.ENVIRONMENT,
        },
        { trigger: "scheduled" },
      ).then((summary) => {
        // 每次執行輸出一筆結構化摘要（規格 06 §25），不含回應內容或任何金鑰。
        console.log(JSON.stringify(summary));
      }),
    );
  },
} satisfies ExportedHandler<IngestEnv>;
