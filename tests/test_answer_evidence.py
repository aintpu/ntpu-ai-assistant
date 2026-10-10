import unittest

import answer_evidence as ae


class QuoteStreamTests(unittest.TestCase):
    def test_quote_block_never_reaches_the_stream_even_when_split(self):
        f = ae.QuoteStreamFilter()
        chunks = ["現任校長是林道通。\n", "【引", "文】\n[{\"source\":\"x\",", "\"quote\":\"林道通\"}]"]
        shown = "".join(f.feed(c) for c in chunks) + f.flush()
        # 標記前的換行可能已送出；完整答案會在 done 事件以拆好的本文取代
        self.assertEqual(shown.strip(), "現任校長是林道通。")

    def test_text_that_only_looks_like_the_marker_start_is_kept(self):
        f = ae.QuoteStreamFilter()
        shown = f.feed("請看【") + f.feed("附件】說明") + f.flush()
        self.assertEqual(shown, "請看【附件】說明")


class QuoteMatchTests(unittest.TestCase):
    CANDS = [
        {"title": "現任校長（校長）", "url": "https://new.ntpu.edu.tw/president", "source_id": "mcp:official:p",
         "content": "職務：校長\n中文姓名：林道通\n任期：2025至今"},
        {"title": "運動會新聞", "url": "https://x", "source_id": "n", "content": "校長林道通 致詞"},
    ]

    def test_split_and_keep_only_verbatim_quotes(self):
        body, quotes = ae.split_quotes(
            '現任校長是林道通。\n【引文】\n[{"source":"現任校長（校長）","quote":"中文姓名：林道通"},'
            '{"source":"現任校長（校長）","quote":"林道通自2020年起擔任校長"}]')
        self.assertEqual(body, "現任校長是林道通。")
        matched = ae.match_quotes(quotes, self.CANDS)
        self.assertEqual(matched, {"mcp:official:p": "中文姓名：林道通"})  # 編造的句子不顯示

    def test_bad_or_missing_quote_block_is_ignored(self):
        self.assertEqual(ae.split_quotes("答案"), ("答案", []))
        self.assertEqual(ae.split_quotes("答案\n【引文】\nnot json"), ("答案", []))


class AnswerCheckTests(unittest.TestCase):
    EVIDENCE = [{"title": "現任校長", "content": "中文姓名：林道通", "quote": "中文姓名：林道通"}]

    def test_unsupported_or_conflicting_answers_become_unconfirmed(self):
        res = ae.check_answer("校長是誰", "校長是宋明翰", self.EVIDENCE,
                              lambda *a, **k: '{"supported": false, "conflict": false, "reason": "證據沒有宋明翰"}')
        self.assertFalse(res["supported"])
        text = ae.unconfirmed_answer(res["reason"], res["conflict"], "zh")
        self.assertIn("目前無法確認", text)
        self.assertIn("證據沒有宋明翰", text)
        self.assertIn("can't confirm", ae.unconfirmed_answer("", True, "en"))

    def test_checker_failure_does_not_block_the_answer(self):
        def boom(*a, **k):
            raise RuntimeError("down")
        self.assertTrue(ae.check_answer("q", "a", self.EVIDENCE, boom)["supported"])
        self.assertTrue(ae.check_answer("q", "a", self.EVIDENCE, lambda *a, **k: "???")["supported"])

    def test_no_answer_replies_and_answers_without_documents_are_not_checked(self):
        self.assertFalse(ae.needs_check("目前查無資料", self.EVIDENCE, ("查無",)))
        self.assertFalse(ae.needs_check("校長是林道通", [], ("查無",)))
        self.assertTrue(ae.needs_check("校長是林道通", self.EVIDENCE, ("查無",)))


if __name__ == "__main__":
    unittest.main()
