"""查一則回答的完整查詢流程（老師建議 五-1）。

    python evaluate/trace.py <message_id 或 conversation_id 開頭> [events.jsonl]
    wrangler tail ... | python evaluate/trace.py <id> -      # 正式站：從標準輸出讀

依序印出：範圍判斷（guardrail）、改寫檢查（rewrite_check）、回答（answer）事件裡的
原始問題、改寫問題、處室路由與原因、工具呼叫、檢索片段（含來源修訂／系統抓取時間）、
資料版本（索引指紋、MCP 同步時間）、證據檢查與最終引用（含原文片段）。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def events(path):
    stream = sys.stdin if path == "-" else open(path, encoding="utf-8")
    for line in stream:
        line = line.strip()
        start = line.find("{")
        if start < 0:
            continue
        try:
            yield json.loads(line[start:])
        except ValueError:
            continue


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    key = sys.argv[1]
    path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "events.jsonl")
    found = [e for e in events(path)
             if str(e.get("message_id", "")).startswith(key) or str(e.get("conversation_id", "")).startswith(key)]
    if not found:
        print(f"找不到 {key}")
        return 1
    for e in found:
        ev = e.get("event")
        print(f"\n=== {ev}  {e.get('ts', '')}")
        if ev == "guardrail":
            for k in ("raw_query", "standalone_query", "result", "scope_status", "route_original", "route_final"):
                if e.get(k) is not None:
                    print(f"  {k}: {e[k]}")
        elif ev == "rewrite_check":
            print(f"  改寫遺漏人名「{e.get('person')}」：{e.get('standalone_query')} → {e.get('fixed_query')}")
        elif ev == "answer":
            print(f"  原始問題：{e.get('raw_query')}")
            print(f"  改寫問題：{e.get('standalone_query')}")
            print(f"  處室路由：{e.get('selected_office')}（{e.get('scope_status')}，{e.get('scope_reason', '')}）")
            for t in e.get("tool_calls") or []:
                print(f"  工具：{t.get('name')} {json.dumps(t.get('args'), ensure_ascii=False)}")
            print(f"  資料版本：索引 {json.dumps(e.get('index_version'), ensure_ascii=False)}；MCP 同步 {e.get('mcp_synced_at')}")
            for s in e.get("retrieved_snippets") or []:
                times = " ".join(f"{k}={s[k]}" for k in ("revised_at", "fetched_at", "confirmed_at") if s.get(k))
                print(f"  片段：[{s.get('source_id')}] {s.get('title')} {times}\n        {s.get('snippet', '')[:120].replace(chr(10), ' ')}")
            if e.get("answer_check"):
                print(f"  證據檢查：{json.dumps(e['answer_check'], ensure_ascii=False)[:300]}")
            for s in e.get("sources") or []:
                print(f"  引用：{s.get('title')} {s.get('url')}" + (f"\n        「{s['quote']}」" if s.get("quote") else ""))
            print(f"  回答：{(e.get('answer') or '')[:300]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
