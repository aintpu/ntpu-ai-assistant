"""依目前的原始題（官網原文題、法規題、處室提供的 Q&A 與整理檔）補改寫題、追問題與應拒答題（沿用 generate.py 的出題方式）。

    python3 evaluate/benchmark/generate_variants.py
    python3 evaluate/benchmark/build_seed.py

寫入 generated.jsonl（可中斷後續跑）；改寫題優先補未達 30 題的單位。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_seed  # noqa: E402
import generate  # noqa: E402  （會切換工作目錄並設定環境）


def main():
    adapter = generate.llm()
    rows = build_seed.load_generated()
    seed = build_seed.collect_seed()
    base = [i for i in seed if i["answerable"]] + [
        r for r in rows if r["origin"].startswith(("generated:regulation", "generated:official"))]
    share = build_seed.TYPE_TARGETS["faq"] + build_seed.TYPE_TARGETS["procedure"]
    total = round(len(base) / share)
    pool = [i for i in base if i["official_source"]["url"]]
    done = [r for r in generate.load_done() if build_seed.keep_generated(r)]
    generate.gen_paraphrases(adapter, pool, round(total * build_seed.TYPE_TARGETS["paraphrase"]), done)
    done = [r for r in generate.load_done() if build_seed.keep_generated(r)]
    generate.gen_followups(adapter, pool, round(total * build_seed.TYPE_TARGETS["followup"]), done)
    refuse_seed = [i["question"] for i in seed if i["type"] == "unanswerable"]
    done = [r for r in generate.load_done() if build_seed.keep_generated(r)]
    generate.gen_unanswerable(adapter, round(total * build_seed.TYPE_TARGETS["unanswerable"]) - len(refuse_seed),
                              done, refuse_seed)
    print(f"完成；目標總題數約 {total}")


if __name__ == "__main__":
    main()
