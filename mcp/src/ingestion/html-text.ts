import { parse as parseHtml } from "node-html-parser";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  bull: "•",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  plusmn: "±",
  minus: "−",
  deg: "°",
  micro: "µ",
  para: "¶",
  sect: "§",
  laquo: "«",
  raquo: "»",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  hearts: "♥",
  yen: "¥",
  euro: "€",
  pound: "£",
  cent: "¢",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  shy: "",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * 只留官網上看得到的內容：分頁按鈕已被註解掉（官網看不到、點不到）的分頁內容一併移除。
 * 例：秘書室〈成員介紹〉的「大學社會責任辦公室」分頁按鈕被 <!-- --> 註解掉，內容卻還留在 HTML 裡，
 * 收錄後系統把官網看不到的舊職稱當成答案（2026-10-11 使用者回報）。
 */
export function visibleHtml(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  if (!/tab-pane/i.test(withoutComments)) return withoutComments;
  const root = parseHtml(withoutComments);
  const linked = new Set(
    root
      .querySelectorAll("a[href^='#']")
      .map((a) => (a.getAttribute("href") ?? "").slice(1))
      .filter(Boolean),
  );
  let removed = false;
  for (const pane of root.querySelectorAll(".tab-pane")) {
    const id = pane.getAttribute("id");
    // 預設顯示的分頁（class 含 active）不需要按鈕也看得到
    const shown = /\bactive\b/.test(pane.getAttribute("class") ?? "");
    if (id && !shown && !linked.has(id)) {
      pane.remove();
      removed = true;
    }
  }
  return removed ? root.toString() : withoutComments;
}

const BLOCK_TAGS = "p|div|br|li|tr|h[1-6]|table|ul|ol|section|article|blockquote|pre|hr";

/**
 * 把 strapi 的 HTML 內文轉成純文字，保留官網原文，不改寫內容。
 * 只做結構轉換：區塊標籤換行、去標籤、解碼 HTML entity、整理空白、Unicode NFC。
 * HTML 內容只當資料處理，不執行任何 script。
 */
export function htmlToText(html: string): string {
  const withoutCode = visibleHtml(html)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  const withBreaks = withoutCode
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t");
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  return decodeEntities(stripped)
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[ \t 　]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
