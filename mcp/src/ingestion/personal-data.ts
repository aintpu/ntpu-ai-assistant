/**
 * 個人資料偵測：公告內文若是學生名單（遮罩或未遮罩的姓名、學號），MCP 不轉載，
 * 改記隔離區（原因 PERSONAL_DATA），保留官網連結與原始檔可追溯。
 * 只用固定規則判斷，不使用模型；寧可多擋，被擋的公告仍可從官網連結查看。
 */

const CJK = "\\u4e00-\\u9fff";
/**
 * 遮罩字元：O、全形 Ｏ、○、◯、〇、＊、*。不含 x/X：實際資料裡 x 多半是連接詞或「X光」，
 * 2026-10-03 掃描全部公告沒有用 x 遮罩姓名的例子。
 */
const MASKED_NAME = new RegExp(`[${CJK}][OＯ○◯〇＊*][${CJK}]`, "g");
/** 「二〇二六」這類中文數字裡的〇不是遮罩。 */
const CHINESE_NUMERAL = /^[〇零一二三四五六七八九十百千]$/;
/** 完整學號（本校為 9 碼、以 3 或 4 開頭）。前後接英數、底線、點或連字號的不算（例如圖片檔名 S__412345678.jpg）。 */
const FULL_STUDENT_ID = /(?<![\w.-])[34]\d{8}(?![\w.-])/g;
/** 部分遮罩學號，例如 4xx***xxx、41234****。 */
const MASKED_STUDENT_ID = /(?<![\dA-Za-z])[34][\dxX]{1,5}[*＊]{2,}[\dxX]*(?![\dA-Za-z])/g;
/** 標題像名單或結果公告。 */
const LIST_TITLE = /名單|獲獎|得獎|得主|合格|錄取|抽獎|中獎|結果|榜單|獎勵|獲選/;

/** 常見姓氏（約涵蓋台灣九成以上人口）。 */
const SURNAMES = new Set(
  (
    "陳林黃張李王吳劉蔡楊許鄭謝洪郭邱曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴范方宋鄧杜傅侯曹薛丁卓阮馬董温溫唐藍蔣石古紀姚連馮歐程湯黃田康姜白汪鄒尤巫鐘黎涂龔嚴韓袁金童陸夏柳凃邵錢伍倪溫于譚駱熊任甘秦顧毛章史官萬俞雷粘饒張"
  ).split(""),
);

function maskedNames(text: string): number {
  const found = new Set<string>();
  for (const m of text.matchAll(MASKED_NAME)) {
    const [a, mask, b] = [...m[0]];
    if (mask === "〇" && (CHINESE_NUMERAL.test(a!) || CHINESE_NUMERAL.test(b!))) continue;
    found.add(m[0]);
  }
  return found.size;
}

/** 名單常見的排法：姓名之間以空白、Tab、換行或頓號分隔，每個姓名 2–3 個字、以常見姓氏開頭。 */
function plainNames(text: string): number {
  const tokens = text.split(/[\s、，,；;／/（）()]+/);
  const names = new Set<string>();
  for (const t of tokens) {
    if (new RegExp(`^[${CJK}]{2,3}$`).test(t) && SURNAMES.has(t[0]!)) names.add(t);
  }
  return names.size;
}

/** 名單另一種排法：「系所 姓名 同學」「姓名 老師」，姓名後面直接接稱謂。 */
const TITLED_NAME = new RegExp(`([${CJK}]{2,4})[ \\t\\u3000]*(?:同學|老師|教授)`, "g");

function titledNames(text: string): number {
  const names = new Set<string>();
  for (const m of text.matchAll(TITLED_NAME)) {
    const before = m[1]!;
    // 姓名 2–3 個字、以常見姓氏開頭；前面可能黏著系所名稱。
    const name = [before.slice(-3), before.slice(-2)].find((n) => n.length >= 2 && SURNAMES.has(n[0]!));
    if (name) names.add(name);
  }
  return names.size;
}

export function personalDataReason(title: string, text: string): string | null {
  const all = `${title}\n${text}`;
  const masked = maskedNames(all);
  const ids = new Set([...(all.match(FULL_STUDENT_ID) ?? []), ...(all.match(MASKED_STUDENT_ID) ?? [])]).size;
  const listTitle = LIST_TITLE.test(title);
  const plain = listTitle ? plainNames(text) : 0;
  const titled = listTitle ? titledNames(text) : 0;
  const hits: string[] = [];
  if (masked >= 3 || (masked >= 1 && listTitle)) hits.push(`${masked} masked name(s)`);
  if (ids >= 3) hits.push(`${ids} student id(s)`);
  if (plain >= 10) hits.push(`${plain} name-like entries under a list title`);
  if (titled >= 3) hits.push(`${titled} names followed by 同學/老師/教授 under a list title`);
  return hits.length ? `PERSONAL_DATA: ${hits.join(", ")}; not republished` : null;
}
