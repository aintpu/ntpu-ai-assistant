"""Offline integration checks for all fourteen supplied FAQ corpora."""
import ast
import json
from pathlib import Path
import re
import typing
import unittest

from conversation_guardrail import (
    OFFICE_NAMES, VALID_OFFICES, ConversationState, _normalize_office,
    run_scope_guardrail,
)
from office_catalog import FAQ_OFFICES
from system_faq import QueryDomain, SystemFAQRetriever, should_route_system

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = dict(ord=175, oa=70, lib=187, cic=101, oia=85, eec=111,
                alu=57, sus=42, edusp=26, os=61, vpa=6, vpad=6, vpf=5, pres=6)


def unavailable(*args, **kwargs):
    raise RuntimeError('Offline classifier')


class AddedOfficeTests(unittest.TestCase):
    def test_actual_backend_faq_parser_preserves_all_questions_answers_and_urls(self):
        # Execute the production parsing function without importing provider clients.
        module = ast.parse((ROOT / 'agentic_v2_5_4high.py').read_text())
        functions = [node for node in module.body if isinstance(node, ast.FunctionDef)
                     and node.name in {'split_pages', 'parse_news_blocks', 'parse_faqs', 'parse_all_content'}]
        namespace = dict(List=typing.List, Dict=typing.Dict, Any=typing.Any,
                         Tuple=typing.Tuple, re=re,
                         H1_RE=re.compile(r'^#\s+(.+?)\s*$', re.M),
                         H3_RE=re.compile(r'^###\s+(.+?)\s*$', re.M))
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<parser>', 'exec'), namespace)
        manifest = json.loads((ROOT / 'crawler_data/office_faq_manifest.json').read_text())
        self.assertEqual(sum(EXPECTED.values()), 938)
        for code, count in EXPECTED.items():
            with self.subTest(code=code):
                path = ROOT / 'crawler_data' / f'{code}_faq.md'
                text = path.read_text()
                self.assertTrue(text.startswith('# 常見問題\n'))
                faqs = namespace['parse_all_content'](text)['faqs']
                self.assertEqual(len(faqs), count)
                self.assertEqual([(r['question'], r['url']) for r in faqs],
                                 [(r['question'], r['url']) for r in manifest[code]['records']])
                self.assertTrue(all(r['answer'].strip() for r in faqs))
                self.assertTrue(all('來源網址：' not in r['answer'] for r in faqs))

    def test_catalog_contract_and_state(self):
        self.assertEqual(set(FAQ_OFFICES), set(EXPECTED))
        self.assertEqual(len(VALID_OFFICES), 21)
        for code, (zh, en, _) in FAQ_OFFICES.items():
            with self.subTest(code=code):
                self.assertEqual(OFFICE_NAMES[code], zh)
                self.assertEqual(QueryDomain(code.upper()).value, code.upper())
                self.assertEqual(_normalize_office(zh), code)
                self.assertEqual(_normalize_office(en), code)
                state = ConversationState.from_value({'active_office': code})
                self.assertEqual(state.active_office, code)

    def test_explicit_office_routes_and_system_faq_does_not_intercept(self):
        retriever = SystemFAQRetriever(ROOT / 'system_content.json')
        for code, (name, _, _) in FAQ_OFFICES.items():
            query = f'{name}的聯絡方式是什麼？'
            with self.subTest(code=code):
                decision = run_scope_guardrail(query, {}, unavailable, retries=0)
                self.assertEqual((decision.status, decision.office_hint), ('IN_SCOPE', code))
                self.assertFalse(should_route_system(query, retriever.best(query), threshold=0.56))

    def test_representative_business_queries(self):
        examples = {
            'ord': '研發處的研究倫理審查怎麼申請？',
            'oa': '主計室經費報支服務在哪裡？',
            'lib': '圖書館借書可以續借嗎？',
            'cic': '資訊中心的 VPN 如何使用？',
            'oia': '國際事務處赴外交換如何申請？',
            'eec': '進修暨推廣部隨班附讀怎麼申請？',
            'alu': '校友證怎麼申請？',
            'sus': '永續報告書在哪裡？',
            'edusp': '高教深耕辦公室怎麼聯絡？',
            'os': '秘書室的校務建言如何提出？',
            'vpa': '現任學術副校長是誰？',
            'vpad': '現任行政副校長是誰？',
            'vpf': '財務暨永續發展副校長室怎麼聯絡？',
            'pres': '現任校長是誰？',
        }
        examples_extra = {
            '北大校長是誰': 'pres',
            '國立臺北大學的校長是誰？': 'pres',
            '與校長有約怎麼報名？': 'os',
            '副校長有哪些？': 'pres',
            '北大的副校長是誰': 'pres',
            '學術副校長是誰': 'vpa',
            '財務副校長怎麼聯絡': 'vpf',
            '學術副校長和行政副校長是誰': 'pres',
            '學術副校長室跟財務暨永續發展副校長室怎麼聯絡': 'pres',
        }
        for query, code in examples_extra.items():
            with self.subTest(query=query):
                decision = run_scope_guardrail(query, {}, unavailable, retries=0)
                self.assertEqual((decision.status, decision.office_hint), ('IN_SCOPE', code))
        for code, query in examples.items():
            with self.subTest(code=code):
                decision = run_scope_guardrail(query, {}, unavailable, retries=0)
                self.assertEqual((decision.status, decision.office_hint), ('IN_SCOPE', code))

    def test_unnamed_vice_president_outranks_model_office_guess(self):
        for query in ('副校長有哪些？', '北大校長是誰'):
            with self.subTest(query=query):
                guess = lambda *a, **k: json.dumps({
                    'status': 'IN_SCOPE', 'office_hint': 'vpad', 'confidence': 0.9, 'reason': '',
                })
                decision = run_scope_guardrail(query, {'raw_query': query}, guess, retries=0)
                self.assertEqual((decision.status, decision.office_hint), ('IN_SCOPE', 'pres'))

    def test_scope_prompt_describes_every_faq_office(self):
        from conversation_guardrail import _scope_prompt
        system = _scope_prompt('那他們的研究領域呢', {})[0]['content']
        for code, (zh, _en, keywords) in FAQ_OFFICES.items():
            self.assertIn(f'{code}={zh}（{keywords[0]}', system)
        self.assertIn('研究領域', system)

    def test_frontend_and_system_coverage_match_router(self):
        content = json.loads((ROOT / 'system_content.json').read_text())
        self.assertEqual(set(content['service']['supported_offices_zh']), set(OFFICE_NAMES.values()))
        about = (ROOT / 'front_end/sports-ai-chat/public/about.html').read_text()
        page = (ROOT / 'front_end/sports-ai-chat/app/page.js').read_text()
        for zh, en, _ in FAQ_OFFICES.values():
            self.assertIn(zh, about)
            self.assertIn(en, about)
            self.assertIn(zh, page)


if __name__ == '__main__':
    unittest.main()
