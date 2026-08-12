import { Container, getContainer } from "@cloudflare/containers";

/**
 * 承載既有的 FastAPI 後端（agentic_v2_5_4high.py）。
 *
 * 後端本身不做任何改寫：Dockerfile 讓 uvicorn 監聽 8080，這裡只把請求原樣轉進去。
 */
export class NtpuAiaBackend extends Container {
  // 對應 Dockerfile 的 ENV PORT=8080
  defaultPort = 8080;

  // 休眠即停止計費，但下一位使用者要等喚醒（容器 1-3 秒 + 後端載入索引約 4 秒）。
  // 校園流量零散，設得比預設 10 分鐘長，用少量費用換掉大部分的喚醒等待。
  sleepAfter = "30m";

  constructor(ctx, env) {
    super(ctx, env);
    // envVars 必須在建構時設定：Container.fetch() 只接受 request，
    // 無法在轉發當下傳入啟動參數。
    this.envVars = {
      // 金鑰來自 Worker secret。後端的 config.txt 已排除在映像檔外，
      // 啟動時會直接讀環境變數。
      OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? "",
      // 讓後端知道自己在容器平台上：跳過寫 chat_logs.csv 與 events.jsonl
      // （容器檔案系統是暫時的），改由 stdout 的結構化日誌保存。
      K_SERVICE: "ntpu-aia-api",
      PYTHONUNBUFFERED: "1",
    };
  }

  onStart() {
    console.log(JSON.stringify({ event: "container_start", severity: "INFO" }));
  }

  onStop(params) {
    console.log(JSON.stringify({
      event: "container_stop", severity: "INFO",
      exitCode: params?.exitCode, reason: params?.reason,
    }));
  }

  onError(error) {
    console.log(JSON.stringify({
      event: "container_error", severity: "ERROR", error: String(error),
    }));
  }
}

export default {
  async fetch(request, env) {
    // 固定單一執行個體：索引在啟動時載入記憶體，多開一份就多算一份記憶體費用，
    // 且各執行個體的狀態不共用。
    const backend = getContainer(env.BACKEND, "singleton");

    try {
      // 用 fetch() 而非 containerFetch()：前者保留串流（/api/chat/stream 是 SSE，
      // 逐字回傳），也是唯一支援 WebSocket 的方法。
      return await backend.fetch(request);
    } catch (err) {
      console.log(JSON.stringify({
        event: "proxy_error", severity: "ERROR", error: String(err),
        path: new URL(request.url).pathname,
      }));
      return new Response(
        JSON.stringify({ status: "error", message: "後端暫時無法連線，請稍後再試。" }),
        { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } },
      );
    }
  },
};
