// 查詢流程紀錄長期保存（老師建議 五-1）：後端事件寫入 D1 query_events。

export const QUERY_LOG_PATH = "/api/internal/query-log";
const QUERY_LOG_MAX_BYTES = 256 * 1024;

/** 比較兩個字串是否相同，所需時間不因第幾個字元不同而改變（避免以回應時間猜 token）。 */
function sameSecret(a, b) {
  const x = new TextEncoder().encode(a || "");
  const y = new TextEncoder().encode(b || "");
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * 查詢流程紀錄（老師建議 五-1）：只接受帶正確 token 的 POST，寫入 D1 query_events。
 * 對外一律只回狀態碼，不回錯誤細節。
 */
export async function storeQueryLog(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!env.QUERY_LOG_DB || !env.QUERY_LOG_TOKEN) return new Response(null, { status: 503 });
  const auth = request.headers.get("authorization") || "";
  if (!sameSecret(auth.replace(/^Bearer\s+/i, ""), env.QUERY_LOG_TOKEN)) return new Response(null, { status: 401 });
  const text = await request.text();
  if (text.length > QUERY_LOG_MAX_BYTES) return new Response(null, { status: 413 });
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!rec || typeof rec !== "object" || typeof rec.event !== "string") return new Response(null, { status: 400 });
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  try {
    await env.QUERY_LOG_DB.prepare(
      `INSERT INTO query_events (ts, event, message_id, conversation_id, raw_query, selected_office, payload_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      str(rec.ts, 40) || new Date().toISOString(), rec.event.slice(0, 40), str(rec.message_id, 64),
      str(rec.conversation_id, 64), str(rec.raw_query, 1000), str(rec.selected_office, 40), text,
    ).run();
  } catch (err) {
    console.log(JSON.stringify({ event: "query_log_error", severity: "ERROR", error: String(err).slice(0, 200) }));
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 204 });
}
