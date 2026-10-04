"""Convert supplied FAQ workbooks to the existing Markdown ingestion format.

Only the FAQ sheet is data. Readme/FAQ_MCP sheets are not executable instructions.

    python scripts/import_office_faqs.py ~/Downloads                      # 只轉成 crawler_data/*_faq.md
    python scripts/import_office_faqs.py ~/Downloads --upload production  # 轉完直接上傳到 MCP（R2 manual/）

每個處室取檔名日期最新的一份（NTPU_<代碼>_FAQ_<YYYYMMDD>-*.xlsx）。整批驗證通過才會寫檔或上傳。
上傳後 MCP 會在下一輪抓取時更新；機器人本機索引則要把 crawler_data/ 的變更 commit、合併後才會更新。
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
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


WORKBOOK_RE = re.compile(r'NTPU_([A-Z]+)_FAQ_(\d{8})-.*\.xlsx')


def latest_workbook(source: Path, code: str) -> Path:
    """這個處室檔名日期最新的一份；最新日期有兩份以上時拒絕（不知道該用哪份）。"""
    dated = {}
    for path in source.glob(f'NTPU_{code.upper()}_FAQ_*.xlsx'):
        m = WORKBOOK_RE.fullmatch(path.name)
        if m and m.group(1) == code.upper():
            dated.setdefault(m.group(2), []).append(path)
    if not dated:
        raise ValueError(f'{code}: no workbook named NTPU_{code.upper()}_FAQ_<YYYYMMDD>-*.xlsx')
    newest = dated[max(dated)]
    if len(newest) != 1:
        raise ValueError(f'{code}: {len(newest)} workbooks share the newest date {max(dated)}')
    return newest[0]


def upload(env: str) -> None:
    mcp = ROOT / 'mcp'
    if not (mcp / 'node_modules' / '.bin' / 'wrangler').exists():
        subprocess.run(['npm', 'ci'], cwd=mcp, check=True)
    subprocess.run(['node', 'scripts/upload-manual.mjs', '--env', env], cwd=mcp, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('source', type=Path)
    parser.add_argument('--upload', choices=['staging', 'production'], help='轉完後上傳到 MCP')
    args = parser.parse_args()
    previous = {}
    manifest_path = ROOT / 'crawler_data' / 'office_faq_manifest.json'
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding='utf-8'))
    pending, manifest = {}, {}
    for code, (name, _, _) in FAQ_OFFICES.items():
        path = latest_workbook(args.source, code)
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
    for code, v in manifest.items():
        old = previous.get(code, {})
        changed = '（未變更）' if old.get('markdown_sha256') == v['markdown_sha256'] else f"（變更，原 {old.get('count', 0)} 題）"
        print(f"{code}\t{v['count']} 題\t{v['workbook']}\t{changed}")
    print(f'Total: {sum(v["count"] for v in manifest.values())} FAQs')
    if args.upload:
        upload(args.upload)


if __name__ == '__main__':
    main()
