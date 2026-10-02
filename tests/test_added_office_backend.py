"""Build the actual corpus offline and verify department metadata at the index boundary."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

os.environ.setdefault('OPENAI_API_KEY', 'test-only-key')
os.environ['NTPU_SKIP_INDEX_BUILD'] = '1'
try:
    import agentic_v2_5_4high as core
    _IMPORT_ERROR = ''
except ModuleNotFoundError as exc:
    _IMPORT_ERROR = str(exc)

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipIf(_IMPORT_ERROR, f'backend dependencies unavailable: {_IMPORT_ERROR}')
class AddedOfficeBackendTests(unittest.TestCase):
    def test_all_imported_faqs_reach_actual_index_with_correct_department_and_url(self):
        index = core.OPEIndex()
        # Only embeddings and cache writes are mocked; all corpus parsers run.
        with patch.object(index, '_try_load_cache', return_value=False), \
                patch.object(index, '_save_cache') as save, \
                patch.object(core.FAISS, 'from_documents') as embed, \
                patch('builtins.print'):
            index.build()
        manifest = json.loads((ROOT / 'crawler_data/office_faq_manifest.json').read_text())
        embed.assert_called_once()
        self.assertIs(embed.call_args.args[0], index.docs_zh)
        save.assert_called_once()
        for code, spec in manifest.items():
            with self.subTest(code=code):
                docs = [doc for doc in index.docs_zh if doc.metadata.get('dept') == code]
                self.assertEqual(len(docs), spec['count'])
                self.assertEqual([(doc.metadata['title'], doc.metadata['url']) for doc in docs],
                                 [(row['question'], row['url']) for row in spec['records']])
                self.assertTrue(all(doc.metadata['type'] == 'faq' for doc in docs))
                self.assertIn(spec['name'], core.SYSTEM_STYLE)
                self.assertEqual(core._parse_correction_dept(
                    f'- **所屬處室**：{code}（{spec["name"]}）'), code)
        ids = [doc.metadata['doc_id'] for doc in index.docs_zh]
        self.assertEqual(len(ids), len(set(ids)))

    def test_blocked_message_lists_every_supported_office(self):
        self.assertEqual(len(core.DEPT_NAMES), 21)
        for name in core.DEPT_NAMES.values():
            self.assertIn(name, core._BLOCKED_MSG)

    def test_unnamed_vice_president_query_searches_each_vice_president_office(self):
        index = core.OPEIndex()
        with patch.object(index, '_try_load_cache', return_value=False), \
                patch.object(index, '_save_cache'), \
                patch.object(core.FAISS, 'from_documents'), \
                patch('builtins.print'):
            index.build()
        with patch.object(core, 'INDEX', index), \
                patch.object(core, 'retrieve_and_rerank', return_value=[]) as retrieve, \
                patch.object(core, 'check_evidence_sufficiency') as evidence:
            evidence.return_value.sufficient = True
            evidence.return_value.to_dict.return_value = {}
            context = core.tool_search_database('副校長有哪些', dept='pres')
            self.assertEqual([c.kwargs['dept'] for c in retrieve.call_args_list],
                             ['vpa', 'vpad', 'vpf'])
            for name in ('陳宥杉', '張玉山', '朱炫璉'):
                self.assertIn(name, context)
            self.assertNotIn('林道通', context)
            retrieve.reset_mock()
            context = core.tool_search_database('校長和副校長是誰', dept='pres')
            self.assertEqual([c.kwargs['dept'] for c in retrieve.call_args_list],
                             ['pres', 'vpa', 'vpad', 'vpf'])
            for name in ('林道通', '陳宥杉', '張玉山', '朱炫璉'):
                self.assertIn(name, context)
            retrieve.reset_mock()
            core.tool_search_database('現任校長是誰', dept='pres')
            self.assertEqual([c.kwargs['dept'] for c in retrieve.call_args_list], ['pres'])


if __name__ == '__main__':
    unittest.main()
