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

const BLOCK_TAGS = "p|div|br|li|tr|h[1-6]|table|ul|ol|section|article|blockquote|pre|hr";

/**
 * 把 strapi 的 HTML 內文轉成純文字，保留官網原文，不改寫內容。
 * 只做結構轉換：區塊標籤換行、去標籤、解碼 HTML entity、整理空白、Unicode NFC。
 * HTML 內容只當資料處理，不執行任何 script。
 */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<!--[\s\S]*?-->/g, "")
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
