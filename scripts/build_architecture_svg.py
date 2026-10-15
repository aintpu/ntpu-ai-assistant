"""產生介紹頁的系統架構圖（內嵌 SVG），寫入 front_end/sports-ai-chat/public/about.html 的 <!-- ARCH-DIAGRAM --> 區塊。

    python3 scripts/build_architecture_svg.py

扁平化 SaaS 資訊圖表風格：5 欄（使用者端、安全層、應用服務層、資料層、AI 模型層），欄間藍色箭頭，
應用服務層與資料層之間雙向箭頭，底部語音處理模組以 L 形折線從使用者端連到應用服務層。
內容依實際系統架構；文字有中英兩份（class zh／en，跟著頁面語言切換）。改架構時改 COLUMNS 再重跑。
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ABOUT = os.path.join(ROOT, "front_end", "sports-ai-chat", "public", "about.html")

W, H = 1920, 850
BLUE = "#0B7BBF"
INK = "#24384f"

# (標題中, 標題英, 標題色, 卡片底色, 列描邊, 圖示色, [(圖示, 中, 英), ...])
COLUMNS = [
    ("使用者端", "Users", "#0B4A8F", "#EAF3FB", "#c5dcf2", BLUE, [
        ("student", "學生", "Students"),
        ("staff", "教職員", "Faculty & staff"),
        ("user", "一般使用者", "Visitors"),
        ("laptop", "aia.ntpu.edu.tw", "aia.ntpu.edu.tw"),
    ]),
    ("安全層", "Security", "#F58220", "#FFF3E6", "#f7cfa4", "#F58220", [
        ("lock", "HTTPS・Cloudflare", "HTTPS · Cloudflare"),
        ("wall", "頻率限制・安全標頭", "Rate limit · headers"),
        ("shield", "範圍判斷（擋外校、無關）", "Scope guardrail"),
        ("check", "紀錄遮罩個資", "PII masking in logs"),
    ]),
    ("應用服務層", "Application", "#0A6FB0", "#E8F4FC", "#c3dff3", BLUE, [
        ("globe", "Worker：網頁與 API", "Worker · web & API"),
        ("group", "處室判斷・問題改寫", "Routing · rewrite"),
        ("doc", "檢索・合併排序", "Retrieve · rank"),
        ("check", "證據檢查・附來源", "Evidence check · cite"),
    ]),
    ("資料層", "Data", "#0B96D8", "#E6F3FB", "#bfe0f3", BLUE, [
        ("swap", "MCP 服務", "MCP server"),
        ("db", "公告・內容頁・檔案庫・法規", "News, pages, files, rules"),
        ("doc", "79 個來源每天同步", "79 sources, daily"),
        ("chart", "本機索引 FAISS＋BM25", "FAISS + BM25 index"),
        ("db", "查詢紀錄（長期保存）", "Query logs (D1)"),
    ]),
    ("AI 模型層", "AI Models", "#0E8F8A", "#E6F6F3", "#bfe5df", "#0E8F8A", [
        ("openai", "GPT-6 Luna：改寫、回答", "GPT-6 Luna · answers"),
        ("brain", "Jev 1.13：分類、排序、查核", "Jev 1.13 · route & verify"),
        ("openai", "GPT Transcribe：語音", "GPT Transcribe · speech"),
    ]),
]

COL_W, GAP, TOP, CARD_H = 318, 72, 70, 560
LEFT = (W - (COL_W * 5 + GAP * 4)) // 2
HEAD_H = 92
ROW_H, ROW_GAP = 72, 16


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def label(x, y, zh, en, size=17, weight=500, color=INK, anchor="start"):
    return (f'<text class="zh" x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color}" '
            f'text-anchor="{anchor}">{esc(zh)}</text>'
            f'<text class="en" x="{x}" y="{y}" font-size="{size - 1}" font-weight="{weight}" fill="{color}" '
            f'text-anchor="{anchor}">{esc(en)}</text>')


def icon(kind: str, cx: float, cy: float, c: str) -> str:
    """單色實心扁平圖示（約 32px）。"""
    g = f'<g transform="translate({cx - 16},{cy - 16})" fill="{c}" stroke="none">'
    body = {
        "student": '<circle cx="16" cy="9" r="7"/><path d="M4 31c0-7 5-12 12-12s12 5 12 12z"/>'
                   '<rect x="23" y="17" width="7" height="11" rx="2" opacity=".75"/>',
        "staff": '<circle cx="16" cy="9" r="7"/><rect x="10" y="7" width="12" height="3" rx="1.5" fill="#fff"/>'
                 '<path d="M4 31c0-7 5-12 12-12s12 5 12 12z"/><path d="M16 19l-2 5 2 6 2-6z" fill="#fff"/>',
        "user": '<circle cx="16" cy="9" r="7"/><path d="M4 31c0-7 5-12 12-12s12 5 12 12z"/>',
        "laptop": '<rect x="5" y="6" width="22" height="15" rx="2"/><rect x="8" y="9" width="16" height="9" fill="#fff"/>'
                  '<path d="M2 24h28l-3 4H5z"/>',
        "lock": '<path d="M10 14v-4a6 6 0 0112 0v4h-3v-4a3 3 0 00-6 0v4z"/><rect x="7" y="14" width="18" height="15" rx="3"/>',
        "wall": '<rect x="3" y="6" width="12" height="6" rx="1"/><rect x="17" y="6" width="12" height="6" rx="1"/>'
                '<rect x="3" y="14" width="7" height="6" rx="1"/><rect x="12" y="14" width="10" height="6" rx="1"/>'
                '<rect x="24" y="14" width="5" height="6" rx="1"/><rect x="3" y="22" width="12" height="6" rx="1"/>'
                '<rect x="17" y="22" width="12" height="6" rx="1"/>',
        "shield": '<path d="M16 2l12 5v8c0 8-5 13-12 16C9 28 4 23 4 15V7z"/>'
                  '<path d="M10 16l4 4 8-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>',
        "check": '<circle cx="16" cy="16" r="14"/>'
                 '<path d="M9 16l5 5 9-10" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>',
        "globe": '<circle cx="16" cy="16" r="14"/><path d="M2 16h28M16 2c5 5 5 23 0 28M16 2c-5 5-5 23 0 28" '
                 'stroke="#fff" stroke-width="2" fill="none"/>',
        "group": '<circle cx="11" cy="10" r="5"/><circle cx="22" cy="11" r="4"/><path d="M2 28c0-6 4-10 9-10s9 4 9 10z"/>'
                 '<path d="M19 28c0-4-1-7-3-9 2-1 4-1 6-1 4 0 8 3 8 10z" opacity=".75"/>',
        "doc": '<path d="M7 2h12l7 7v21H7z"/><path d="M11 15h11M11 20h11M11 25h7" stroke="#fff" stroke-width="2"/>',
        "swap": '<path d="M4 11h20l-5-5M28 21H8l5 5" stroke="' + c + '" stroke-width="3.5" fill="none" '
                'stroke-linecap="round" stroke-linejoin="round"/>',
        "chart": '<rect x="4" y="16" width="6" height="13" rx="1.5"/><rect x="13" y="9" width="6" height="20" rx="1.5"/>'
                 '<rect x="22" y="4" width="6" height="25" rx="1.5"/>',
        "db": '<ellipse cx="16" cy="7" rx="11" ry="4.5"/><path d="M5 7v18c0 2.5 5 4.5 11 4.5s11-2 11-4.5V7'
              'c0 2.5-5 4.5-11 4.5S5 9.5 5 7z"/><path d="M5 16c0 2.5 5 4.5 11 4.5s11-2 11-4.5" stroke="#fff" '
              'stroke-width="2" fill="none"/>',
        "mic": '<rect x="11" y="2" width="10" height="17" rx="5"/><path d="M6 15a10 10 0 0020 0" stroke="' + c +
               '" stroke-width="3" fill="none"/><rect x="14.5" y="24" width="3" height="5"/><rect x="10" y="28" width="12" height="3" rx="1.5"/>',
        "chat": '<path d="M3 5h26v17H13l-7 6v-6H3z"/><circle cx="10" cy="13.5" r="2" fill="#fff"/>'
                '<circle cx="16" cy="13.5" r="2" fill="#fff"/><circle cx="22" cy="13.5" r="2" fill="#fff"/>',
        # 示意用的簡化圖形（不是官方商標）
        "openai": "".join(f'<ellipse cx="16" cy="9" rx="4.5" ry="7.5" transform="rotate({a} 16 16)" opacity=".9"/>'
                          for a in range(0, 360, 60)) + '<circle cx="16" cy="16" r="3.5" fill="#fff"/>',
        "brain": '<path d="M13 4c-4 0-7 3-7 6-3 1-4 4-3 7-1 3 1 7 5 8 1 3 4 4 7 3V4z"/>'
                 '<path d="M19 4c4 0 7 3 7 6 3 1 4 4 3 7 1 3-1 7-5 8-1 3-4 4-7 3V4z" opacity=".75"/>',
    }[kind]
    return g + body + "</g>"


def arrow(x1, y1, x2, y2):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{BLUE}" stroke-width="2.5" marker-end="url(#arch-head)"/>'


def build() -> str:
    out = [
        f'<svg class="arch-diagram" viewBox="0 0 {W} {H}" role="img" aria-labelledby="arch-diagram-title" '
        'xmlns="http://www.w3.org/2000/svg" font-family="\'Noto Sans TC\', Inter, system-ui, sans-serif">',
        '<title id="arch-diagram-title">NTPU AI Assistant 系統架構圖 / System architecture</title>',
        '<defs><pattern id="arch-grid" width="32" height="32" patternUnits="userSpaceOnUse">'
        '<path d="M32 0H0V32" fill="none" stroke="#e3e8ee" stroke-width="1"/></pattern>'
        f'<marker id="arch-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
        f'<path d="M0 0L10 5 0 10z" fill="{BLUE}"/></marker></defs>',
        f'<rect width="{W}" height="{H}" fill="#f7f8fa"/><rect width="{W}" height="{H}" fill="url(#arch-grid)"/>',
    ]
    centers = []
    for i, (zh, en, head, bg, rowline, ic, rows) in enumerate(COLUMNS):
        x = LEFT + i * (COL_W + GAP)
        centers.append(x)
        out.append(f'<rect x="{x}" y="{TOP}" width="{COL_W}" height="{CARD_H}" rx="16" fill="{bg}" stroke="{head}" stroke-width="2"/>')
        out.append(f'<path d="M{x + 16} {TOP}h{COL_W - 32}a16 16 0 0116 16v{HEAD_H - 16}H{x}V{TOP + 16}a16 16 0 0116-16z" fill="{head}"/>')
        out.append(label(x + COL_W / 2, TOP + HEAD_H / 2 + 9, zh, en, size=26, weight=700, color="#fff", anchor="middle"))
        total = len(rows) * ROW_H + (len(rows) - 1) * ROW_GAP
        y0 = TOP + HEAD_H + (CARD_H - HEAD_H - total) / 2
        for j, (kind, rzh, ren) in enumerate(rows):
            y = y0 + j * (ROW_H + ROW_GAP)
            out.append(f'<rect x="{x + 18}" y="{y}" width="{COL_W - 36}" height="{ROW_H}" rx="12" fill="#fff" stroke="{rowline}" stroke-width="1"/>')
            out.append(icon(kind, x + 50, y + ROW_H / 2, ic))
            out.append(label(x + 82, y + ROW_H / 2 + 6, rzh, ren, size=16))
    mid = TOP + HEAD_H + (CARD_H - HEAD_H) / 2
    for i in range(4):
        a, b = centers[i] + COL_W + 6, centers[i + 1] - 8
        if i == 2:  # 應用服務層 ⇄ 資料層（查詢與回傳）
            out.append(arrow(a, mid - 14, b, mid - 14))
            out.append(arrow(b + 2, mid + 14, a - 2, mid + 14))
        else:
            out.append(arrow(a, mid, b, mid))
    # 底部語音處理模組（使用者端 → 語音 → 應用服務層）
    x1 = centers[0] + COL_W / 2
    x3 = centers[2] + COL_W / 2
    vx, vy, vh = x1 + 70, TOP + CARD_H + 56, 92
    vw = x3 - x1 - 140
    out.append(f'<rect x="{vx}" y="{vy}" width="{vw}" height="{vh}" rx="16" fill="#fff" stroke="{BLUE}" stroke-width="2"/>')
    out.append(icon("mic", vx + 44, vy + vh / 2, BLUE))
    out.append(icon("chat", vx + vw - 44, vy + vh / 2, BLUE))
    out.append(label(vx + vw / 2, vy + 40, "語音處理模組", "Voice module", size=20, weight=700, color="#0B4A8F", anchor="middle"))
    out.append(label(vx + vw / 2, vy + 68, "錄音 → GPT Transcribe 轉文字 → 一般問答流程", "Record → GPT Transcribe → normal Q&A", size=15, anchor="middle"))
    yb = TOP + CARD_H
    out.append(f'<path d="M{x1} {yb + 4}V{vy + vh / 2}H{vx - 8}" fill="none" stroke="{BLUE}" stroke-width="2.5" marker-end="url(#arch-head)"/>')
    out.append(f'<path d="M{vx + vw + 4} {vy + vh / 2}H{x3}V{yb + 10}" fill="none" stroke="{BLUE}" stroke-width="2.5" marker-end="url(#arch-head)"/>')
    out.append("</svg>")
    return "".join(out)


def main():
    html = open(ABOUT, encoding="utf-8").read()
    block = f"<!-- ARCH-DIAGRAM -->\n      <div class=\"arch-diagram-wrap reveal\">{build()}</div>\n      <!-- /ARCH-DIAGRAM -->"
    if "<!-- ARCH-DIAGRAM -->" in html:
        html = re.sub(r"<!-- ARCH-DIAGRAM -->.*?<!-- /ARCH-DIAGRAM -->", lambda _: block, html, flags=re.S)
    else:
        html = html.replace('<div class="arch">', '<div class="arch">\n      ' + block, 1)
    css = ("  .arch-diagram-wrap{margin:0 0 32px;border-radius:16px;overflow-x:auto;background:#f7f8fa;border:1px solid var(--line)}\n"
           "  .arch-diagram{display:block;width:100%;min-width:900px;height:auto}\n")
    if ".arch-diagram-wrap{" not in html:
        html = html.replace("  .arch-flow", css + "  .arch-flow", 1)
    open(ABOUT, "w", encoding="utf-8").write(html)
    print("architecture diagram written to", ABOUT)


if __name__ == "__main__":
    main()
