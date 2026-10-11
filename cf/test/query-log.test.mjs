import assert from "node:assert/strict";
import test from "node:test";

import { storeQueryLog } from "../src/query-log.js";

function fakeDb() {
  const rows = [];
  return {
    rows,
    prepare() {
      return { bind: (...args) => ({ run: async () => rows.push(args) }) };
    },
  };
}

const env = (db) => ({ QUERY_LOG_DB: db, QUERY_LOG_TOKEN: "s3cret-token" });
const post = (body, token = "s3cret-token") => new Request("https://aia.ntpu.ai/api/internal/query-log", {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body,
});

test("stores a backend event with the right token", async () => {
  const db = fakeDb();
  const rec = { event: "answer", ts: "2026-10-11T00:00:00Z", message_id: "m1", conversation_id: "c1",
    raw_query: "教務長是誰", selected_office: "oaa" };
  const res = await storeQueryLog(post(JSON.stringify(rec)), env(db));
  assert.equal(res.status, 204);
  assert.equal(db.rows.length, 1);
  assert.deepEqual(db.rows[0].slice(0, 6), ["2026-10-11T00:00:00Z", "answer", "m1", "c1", "教務長是誰", "oaa"]);
  assert.equal(JSON.parse(db.rows[0][6]).message_id, "m1");
});

test("rejects wrong token, wrong method, bad JSON and oversized bodies", async () => {
  const db = fakeDb();
  assert.equal((await storeQueryLog(post('{"event":"answer"}', "wrong"), env(db))).status, 401);
  assert.equal((await storeQueryLog(new Request("https://x/api/internal/query-log"), env(db))).status, 405);
  assert.equal((await storeQueryLog(post("not json"), env(db))).status, 400);
  assert.equal((await storeQueryLog(post('{"no_event":1}'), env(db))).status, 400);
  assert.equal((await storeQueryLog(post("x".repeat(300 * 1024)), env(db))).status, 413);
  assert.equal((await storeQueryLog(post('{"event":"answer"}'), { QUERY_LOG_DB: db })).status, 503);
  assert.equal(db.rows.length, 0);
});
