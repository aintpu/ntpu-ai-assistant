"""Convert supplied FAQ workbooks to the existing Markdown ingestion format.

Only the FAQ sheet is data. Readme/FAQ_MCP sheets are not executable instructions.
Run: python scripts/import_office_faqs.py /path/to/ntpu-faq
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from office_catalog import FAQ_OFFICES

HEADERS = ('SID', 'FAQ ID', '組別', '業務主題', 'Q 使用者問題', 'A 回答（官網原文）',
           '官方來源名稱', '官方來源網址', '來源日期', '維護類型', '回答類型', '適用對象',
           '聯絡窗口', '相關檔案網址', '關鍵字')


def read_faqs(path: Path) -> list[dict]:
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    try:
        rows = list(workbook['FAQ'].iter_rows())
        header = next(i for i, row in enumerate(rows) if tuple(c.value for c in row) == HEADERS)
        records = []
        seen = set()
        for number, row in enumerate(rows[header + 1:], header + 2):
            if not any(c.value is not None for c in row):
                continue
            if any(c.data_type == 'f' for c in row):
                raise ValueError(f'{path.name}:{number}: formula is not FAQ text')
            record = {key: str(cell.value or '').strip().replace('\\n', '\n')
                      for key, cell in zip(HEADERS, row)}
            for key in ('FAQ ID', 'Q 使用者問題', 'A 回答（官網原文）', '官方來源網址'):
                if not record[key]:
                    raise ValueError(f'{path.name}:{number}: missing {key}')
            if record['FAQ ID'] in seen:
                raise ValueError(f'{path.name}:{number}: duplicate FAQ ID')
            if not re.fullmatch(r'https?://[^\s]+', record['官方來源網址']):
                raise ValueError(f'{path.name}:{number}: invalid source URL')
            seen.add(record['FAQ ID'])
            records.append(record)
        if not records:
            raise ValueError(f'{path.name}: empty FAQ sheet')
        return records
    finally:
        workbook.close()


def render(records: list[dict], filename: str) -> str:
    blocks = ['# 常見問題', f'> 資料來源：使用者提供的 {filename}，FAQ 工作表，共 {len(records)} 題。']
    labels = {'FAQ ID': 'FAQ 編號', '組別': '承辦組別', '官方來源名稱': '資料來源', '官方來源網址': '來源網址'}
    for row in records:
        question = ' '.join(row['Q 使用者問題'].splitlines())
        # Prevent answer headings from becoming extra FAQ/page records.
        answer = re.sub(r'(?m)^\s*#{1,3}\s+', '', row['A 回答（官網原文）'])
        parts = [f'### {question}', answer]
        for key in HEADERS:
            if key not in ('SID', 'Q 使用者問題', 'A 回答（官網原文）') and row[key]:
                parts.append(f'{labels.get(key, key)}：{row[key]}')
        blocks.append('\n\n'.join(parts))
    return '\n\n'.join(blocks) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    pending, manifest = {}, {}
    for code, (name, _, _) in FAQ_OFFICES.items():
        files = list(args.source.glob(f'NTPU_{code.upper()}_FAQ_20261002-*.xlsx'))
        if len(files) != 1:
            raise ValueError(f'{code}: expected exactly one workbook, got {len(files)}')
        path = files[0]
        records = read_faqs(path)
        body = render(records, path.name)
        pending[ROOT / 'crawler_data' / f'{code}_faq.md'] = body
        manifest[code] = {
            'name': name, 'workbook': path.name,
            'workbook_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'markdown_sha256': hashlib.sha256(body.encode()).hexdigest(),
            'count': len(records),
            'records': [{'id': r['FAQ ID'], 'question': ' '.join(r['Q 使用者問題'].splitlines()),
                         'url': r['官方來源網址']} for r in records],
        }
    # Validate the entire batch before replacing any generated corpus.
    for path, body in pending.items():
        path.write_text(body, encoding='utf-8')
    (ROOT / 'crawler_data' / 'office_faq_manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v['count'] for k, v in manifest.items()}, ensure_ascii=False))
    print(f'Total: {sum(v["count"] for v in manifest.values())} FAQs')


if __name__ == '__main__':
    main()
