import { Container, getContainer } from "@cloudflare/containers";

/**
 * 承載既有的 FastAPI 後端（agentic_v2_5_4high.py）。
 *
 * 後端仍由 Dockerfile 啟動 uvicorn；本層另外負責把每個 conversation_id 的
 * Conversation State 存在 Durable Object storage，並在轉發前注入最新 state。
 */

const HEALTH_PATH = "/api/health";
const HEALTH_DEEP_PATH = "/api/health/backend";

const SESSION_STORAGE_PREFIX = "conversation-session:";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ROUTES = new Set([
  "/api/chat",
  "/api/chat/stream",
  "/api/voice",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeConversationId(value) {
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

function sanitizeConversationState(value, conversationId) {
  if (!isRecord(value)) return null;

  const text = (candidate, maxLength = 1200) => (
    typeof candidate === "string" ? candidate.trim().slice(0, maxLength) || null : null
  );
  const rawSourceIds = Array.isArray(value.previous_source_ids)
    ? value.previous_source_ids
    : [];

  // 與 Python ConversationState 對齊，只保存 resolver 需要的欄位；不保存完整對話
  // history，降低個資暴露與 Durable Object storage 的無限成長風險。
  return {
    conversation_id: conversationId,
    active_office: text(value.active_office, 32),
    active_topic: text(value.active_topic, 200),
    scope_verified: Boolean(value.scope_verified),
    previous_user_query: text(value.previous_user_query),
    previous_standalone_query: text(value.previous_standalone_query),
    previous_source_ids: rawSourceIds
      .filter((sourceId) => sourceId !== null && sourceId !== undefined && sourceId !== "")
      .map((sourceId) => String(sourceId).slice(0, 200))
      .slice(0, 20),
    conversation_summary: text(value.conversation_summary, 600),
    last_updated_at: text(value.last_updated_at, 64) || new Date().toISOString(),
  };
}

function parseSsePayloads(frame) {
  const payloads = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const payload = JSON.parse(raw);
      if (isRecord(payload)) payloads.push(payload);
    } catch {
      // A malformed SSE frame should not interrupt the user's answer.
    }
  }
  return payloads;
}

export class NtpuAiaBackend extends Container {
  // 對應 Dockerfile 的 ENV PORT=8080
  defaultPort = 8080;

  // 休眠即停止計費，但下一位使用者要等喚醒（容器 1-3 秒 + 後端載入索引約 4 秒）。
  // 校園流量零散，設得比預設 10 分鐘長，用少量費用換掉大部分的喚醒等待。
  sleepAfter = "30m";

  constructor(ctx, env) {
    super(ctx, env);

    // 診斷用：只記錄金鑰「有沒有拿到」與長度，不記錄內容。
    // Durable Object 是長期存活的，其建構式取得的 env 會一直沿用到執行個體被
    // 汰換為止；新增 secret 後若沒有重新部署，這裡就會是 missing。
    const key = env.OPENAI_API_KEY ?? "";
    console.log(JSON.stringify({
      event: "container_env_check", severity: key ? "INFO" : "ERROR",
      openai_api_key: key ? `present(len=${key.length})` : "MISSING",
    }));

    // envVars 必須在建構時設定：Container.fetch() 只接受 request，
    // 無法在轉發當下傳入啟動參數。實際內容於容器啟動時才被讀取。
    this.envVars = {
      // 金鑰來自 Worker secret。後端的 config.txt 已排除在映像檔外，
      // 啟動時會直接讀環境變數。
      OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? "",
      SYSTEM_PRIMARY_THRESHOLD: env.SYSTEM_PRIMARY_THRESHOLD ?? "0.56",
      SYSTEM_FALLBACK_THRESHOLD: env.SYSTEM_FALLBACK_THRESHOLD ?? "0.72",
      // 讓後端知道自己在容器平台上：跳過寫 chat_logs.csv 與 events.jsonl
      // （容器檔案系統是暫時的），改由 stdout 的結構化日誌保存。
      K_SERVICE: "ntpu-aia-api",
      PYTHONUNBUFFERED: "1",
    };
  }

  onStart() {
    this._startedAt = Date.now();
    console.log(JSON.stringify({
      event: "container_start", severity: "INFO",
      at: new Date().toISOString(),
    }));
  }

  onStop(params) {
    // awake_s 是本次喚醒實際運行的秒數。Memory / Disk 以「配置資源 × 運行時間」
    // 計費，把這個數字乘上配置量就是本次喚醒的成本，可用來驗證 sleepAfter 的效果。
    console.log(JSON.stringify({
      event: "container_stop", severity: "INFO",
      at: new Date().toISOString(),
      awake_s: this._startedAt ? Math.round((Date.now() - this._startedAt) / 1000) : null,
      exitCode: params?.exitCode, reason: params?.reason,
    }));
  }

  onError(error) {
    console.log(JSON.stringify({
      event: "container_error", severity: "ERROR", error: String(error),
    }));
  }

  _sessionKey(conversationId) {
    return `${SESSION_STORAGE_PREFIX}${conversationId}`;
  }

  async _loadConversationState(conversationId) {
    if (!conversationId) return null;
    const key = this._sessionKey(conversationId);
    const record = await this.ctx.storage.get(key);
    if (!isRecord(record) || !isRecord(record.state)) return null;

    const updatedAt = Date.parse(record.updated_at || "");
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt > SESSION_TTL_MS) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return sanitizeConversationState(record.state, conversationId);
  }

  async _saveConversationState(conversationId, state) {
    const safeState = sanitizeConversationState(state, conversationId);
    if (!conversationId || !safeState) return;

    await this.ctx.storage.put(this._sessionKey(conversationId), {
      version: 1,
      conversation_id: conversationId,
      state: safeState,
      updated_at: new Date().toISOString(),
    });
  }

  async _persistJsonResponse(conversationId, response) {
    try {
      const payload = await response.clone().json();
      if (isRecord(payload) && isRecord(payload.conversation_state)) {
        await this._saveConversationState(
          normalizeConversationId(payload.conversation_id) || conversationId,
          payload.conversation_state,
        );
      }
    } catch (error) {
      console.log(JSON.stringify({
        event: "conversation_state_persist_error",
        severity: "ERROR",
        stage: "json_response",
        error: String(error),
      }));
    }
  }

  async _persistStream(conversationId, stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalState = null;
    let finalConversationId = conversationId;

    const consumeFrames = (text) => {
      buffer += text;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) {
        for (const payload of parseSsePayloads(frame)) {
          if (payload.type !== "done" || !isRecord(payload.conversation_state)) continue;
          finalState = payload.conversation_state;
          finalConversationId = normalizeConversationId(payload.conversation_id) || conversationId;
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeFrames(decoder.decode(value, { stream: true }));
      }
      consumeFrames(decoder.decode());
      for (const payload of parseSsePayloads(buffer)) {
        if (payload.type === "done" && isRecord(payload.conversation_state)) {
          finalState = payload.conversation_state;
          finalConversationId = normalizeConversationId(payload.conversation_id) || conversationId;
        }
      }
      if (finalState) await this._saveConversationState(finalConversationId, finalState);
    } catch (error) {
      console.log(JSON.stringify({
        event: "conversation_state_persist_error",
        severity: "ERROR",
        stage: "stream_response",
        error: String(error),
      }));
    } finally {
      reader.releaseLock();
    }
  }

  async _prepareConversationRequest(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || !SESSION_ROUTES.has(url.pathname)) {
      return { request, conversationId: "" };
    }

    let payload;
    try {
      payload = await request.clone().json();
    } catch {
      return { request, conversationId: "" };
    }
    if (!isRecord(payload)) {
      return { request, conversationId: "" };
    }

    let conversationId = normalizeConversationId(payload.conversation_id)
      || normalizeConversationId(payload.session_id);
    if (!conversationId) conversationId = crypto.randomUUID();

    let storedState = null;
    try {
      storedState = await this._loadConversationState(conversationId);
    } catch (error) {
      // Storage 暫時異常時仍讓本輪請求進容器；client state 可作為短期 fallback。
      console.log(JSON.stringify({
        event: "conversation_state_load_error",
        severity: "ERROR",
        error: String(error),
      }));
    }
    const suppliedState = sanitizeConversationState(payload.conversation_state, conversationId);
    payload.conversation_id = conversationId;
    payload.session_id = conversationId;
    // Durable Object storage 是正式環境的 source of truth；只有第一次請求或
    // 舊版 client 尚未有 server record 時，才接受 request 內附的 state 作為 bootstrap。
    payload.conversation_state = storedState || suppliedState || {
      conversation_id: conversationId,
    };

    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return {
      request: new Request(request, {
        body: JSON.stringify(payload),
        headers,
      }),
      conversationId,
    };
  }

  async fetch(request) {
    const prepared = await this._prepareConversationRequest(request);
    const response = await this.containerFetch(prepared.request);

    if (!prepared.conversationId) return response;

    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/chat/stream" && response.body) {
      const [clientStream, auditStream] = response.body.tee();
      const persistPromise = this._persistStream(prepared.conversationId, auditStream);
      if (typeof this.ctx.waitUntil === "function") {
        this.ctx.waitUntil(persistPromise);
      } else {
        void persistPromise;
      }
      return new Response(clientStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    await this._persistJsonResponse(prepared.conversationId, response);
    return response;
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // 非 API 路徑交還給 Static Assets（前端的靜態輸出）。
    // run_worker_first 只列了 /api/*，理論上不會走到這裡，但明確處理可避免
    // 日後調整路由設定時把整個前端擋掉。
    if (!pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // 淺層健康檢查在 Worker 邊緣回應，不喚醒容器。
    // 回應內容本來就只是常數，卻足以把休眠中的容器叫醒；監控服務或爬蟲定期打
    // 這個路徑時，等於持續產生無謂的 Memory 計費。
    // 要確認「後端本身」是否正常，改打 HEALTH_DEEP_PATH。
    if (pathname === HEALTH_PATH) {
      return Response.json({ status: "ok", served_by: "worker" });
    }

    // 深層健康檢查：明確指定才進容器，供部署後驗證後端與模型設定。
    // 後端只認得 /api/health，因此轉發前把路徑改寫回去。
    let upstream = request;
    if (pathname === HEALTH_DEEP_PATH) {
      const target = new URL(request.url);
      target.pathname = HEALTH_PATH;
      upstream = new Request(target, request);
    }

    // 記錄每個真的會進容器的請求。容器休眠時，這些就是把它叫醒的元凶；
    // 與 container_start / container_stop 對照即可回答「是誰讓容器一直醒著」。
    console.log(JSON.stringify({
      event: "container_request", severity: "INFO",
      at: new Date().toISOString(),
      path: pathname,
      method: request.method,
      user_agent: (request.headers.get("user-agent") || "").slice(0, 200),
      country: request.cf?.country || "",
    }));

    // 固定單一執行個體：索引在啟動時載入記憶體，多開一份就多算一份記憶體費用；
    // 對話 state 則由 Durable Object storage 持久保存，不依賴容器記憶體。
    const backend = getContainer(env.BACKEND, "singleton");

    try {
      // 用 fetch() 而非 containerFetch()：前者保留串流（/api/chat/stream 是 SSE，
      // 逐字回傳），也是唯一支援 WebSocket 的方法。
      return await backend.fetch(upstream);
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
