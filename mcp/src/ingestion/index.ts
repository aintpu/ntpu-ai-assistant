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
        // 本機可用 /__scheduled?cron=source:<來源 id> 指定來源；
        // cron=reverify:<來源 id>:<ISO 時間> 重新驗證在那之前驗證過的內文（重複執行到 deferred 為 0）。
        // 正式環境的 cron 字串只來自 wrangler 設定，無法帶入這兩種值。
        const [mode, id, ...rest] = controller.cron.split(":") as [string, string | undefined, ...string[]];
        const reverifyBefore = mode === "reverify" ? rest.join(":") : "";
        if (mode === "reverify" && Number.isNaN(Date.parse(reverifyBefore))) {
          console.error(JSON.stringify({ type: "ingestion_error", reason: "reverify needs an ISO time" }));
          return;
        }
        const requested = mode === "source" || mode === "reverify" ? getSource(id ?? "") : undefined;
        const source = requested ?? (await pickDueSource(deps.store, systemClock.nowIso()));
        if (!source) {
          console.log(JSON.stringify({ type: "ingestion_idle", reason: "no source due" }));
          return;
        }
        const summary = await runIngestion(deps, {
          sourceIds: [source.id],
          trigger: "scheduled",
          reverifyBefore: mode === "reverify" && requested !== undefined ? reverifyBefore : undefined,
        });
        // 每次執行輸出一筆結構化摘要（規格 06 §25），不含回應內容或任何金鑰。
        console.log(JSON.stringify(summary));
      })(),
    );
  },
} satisfies ExportedHandler<IngestEnv>;
