import { CanonicalStore } from "../db/canonical-store";
import { systemClock } from "../shared/clock";
import { R2RawArchive } from "./raw-archive";
import { pickDueSource, runIngestion } from "./run-ingestion";
import { assertRegistryValid, getSource } from "./source-registry";

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

  async scheduled(controller: ScheduledController, env: IngestEnv, ctx: ExecutionContext): Promise<void> {
    const deps = {
      store: new CanonicalStore(env.DB),
      archive: new R2RawArchive(env.RAW),
      fetch: (request: Request) => fetch(request),
      clock: systemClock,
      environment: env.ENVIRONMENT,
    };
    ctx.waitUntil(
      (async () => {
        // 本機測試可用 /__scheduled?cron=source:<來源 id> 指定來源；正式 cron 字串只來自 wrangler 設定。
        const requested = controller.cron.startsWith("source:") ? getSource(controller.cron.slice(7)) : undefined;
        const source = requested ?? (await pickDueSource(deps.store, systemClock.nowIso()));
        if (!source) {
          console.log(JSON.stringify({ type: "ingestion_idle", reason: "no source due" }));
          return;
        }
        const summary = await runIngestion(deps, { sourceIds: [source.id], trigger: "scheduled" });
        // 每次執行輸出一筆結構化摘要（規格 06 §25），不含回應內容或任何金鑰。
        console.log(JSON.stringify(summary));
      })(),
    );
  },
} satisfies ExportedHandler<IngestEnv>;
