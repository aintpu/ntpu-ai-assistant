// 現任主管換人偵測（使用者 2026-10-11 選定：程式抓候選姓名，人工確認後才上線）。
//
//   node --experimental-strip-types scripts/check-officials.mjs [--write] [--report report.json]
//
// 逐頁抓 src/ingestion/officials.ts 列出的主管介紹頁（學校公開 API），檢查對照表的姓名是否仍在頁面上。
// 不在了就從頁面抓出候選姓名；加 --write 時把候選姓名寫回 officials.ts（英文姓名與任期清空，待人工補）。
// 寫回的內容不會直接上線：GitHub Actions（.github/workflows/officials-check.yml）把它推到分支並開 issue，
// 由人確認頁面後建立 PR 合併，MCP 部署後才生效。抓不到候選姓名時只回報，不修改。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://api-carrier.ntpu.edu.tw/strapi";
const SITE = "https://new.ntpu.edu.tw";
const TABLE = fileURLToPath(new URL("../src/ingestion/officials.ts", import.meta.url));

export const SURNAMES = new Set(
  "陳林黃張李王吳劉蔡楊許鄭謝洪郭邱曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴范方宋鄧杜傅侯" +
    "曹薛丁卓阮馬董温溫唐藍蔣石古紀姚連馮歐程湯田康姜白汪鄒尤巫鐘黎涂龔嚴韓袁金童陸夏柳凃邵錢伍倪于譚駱熊任甘秦顧毛章史官萬俞雷粘饒",
);
// 看起來像姓名、其實是常見詞的組合（姓氏字開頭的一般詞）
const NOT_NAMES = /^(國立|臺北|台北|學校|學術|學務|學生|高教|高等|教務|教授|總務|研究|研發|國際|主任|主計|圖書|資訊|通識|體育|進修|校友|秘書|行政|財務|永續|發展|副校|校長|任期|現任|曾任|經歷|學歷|博士|碩士|學士|大學|中心|專長|聯絡|電話|信箱|簡介|介紹|成員|業務|管理|系統|服務|計畫|辦公|單位|組長|史丹|史學|方法|方案|施政|余暇|任職|任教|金融|康健|石油|田野|白皮|章程|官方|萬一)/;

// 單位或職稱片段的結尾（「工程學系」切出的「程學系」、「主任助理」切出的「任助理」）
const NOT_NAME_END = /(系|所|院|心|副|理|處|室|組|部|館|會|長)$/;

const htmlText = (html) =>
  (html || "").replace(/<[^>]+>|&nbsp;/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

/** 從主管介紹頁抓候選姓名：職稱旁邊的 2–3 字姓名（常見姓氏開頭），其次是頁面開頭的姓名。 */
export function candidateNames(text, title) {
  const head = text.slice(0, 800);
  const name = "([\\u4e00-\\u9fff]{2,3})";
  const counts = new Map();
  const add = (n, weight) => {
    for (const cut of [n, n.slice(0, 2)]) {
      // 「林道通校」這類多抓到的字：3 字不合格時退回 2 字
      if (cut.length >= 2 && SURNAMES.has(cut[0]) && !NOT_NAMES.test(cut) && !NOT_NAME_END.test(cut) && !title.includes(cut)) {
        counts.set(cut, (counts.get(cut) || 0) + weight);
        return;
      }
    }
  };
  const t = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of head.matchAll(new RegExp(`${t}\\s*[：:]?\\s*${name}`, "g"))) add(m[1], 3);
  for (const m of head.matchAll(new RegExp(`${name}\\s*(?:${t}|校長|教授|博士|主任|館長)`, "g"))) add(m[1], 2);
  // 主管介紹頁通常把姓名單獨放在開頭：第一個單獨出現的姓名權重最高（勝過「歷任」名單裡職稱旁的前任姓名）
  let first = true;
  for (const m of head.slice(0, 120).matchAll(new RegExp(`(?:^|[\\s，,。|｜])${name}(?=[\\s，,。|｜]|$)`, "g"))) {
    const before = counts.size;
    add(m[1], first ? 6 : 1);
    if (counts.size > before) first = false;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

async function fetchPages(paths) {
  const query = `{ sections(where:{name_in:${JSON.stringify(paths)}}) { name title content content_en updatedAt } }`;
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "NTPU-AIA-OfficialsCheck/0.1 (+https://aia.ntpu.ai/about)" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`school API HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data?.sections)) throw new Error("school API returned no sections");
  return new Map(body.data.sections.map((s) => [s.name, s]));
}

/** 檢查每位主管；回傳 [{ path, title, oldName, status: ok|changed|missing_page|no_candidate, candidates, url }] */
export function checkOfficials(officials, pages) {
  return officials.map((o) => {
    const page = pages.get(o.path);
    const url = SITE + o.path;
    const base = { path: o.path, title: o.title, oldName: o.name, url, candidates: [] };
    if (!page) return { ...base, status: "missing_page" };
    const zh = htmlText(page.content);
    const en = htmlText(page.content_en).toLowerCase();
    const stillThere = o.name ? zh.includes(o.name) : Boolean(o.nameEnOfficial && en.includes(o.nameEnOfficial.toLowerCase()));
    if (stillThere) return { ...base, status: "ok" };
    const candidates = candidateNames(zh, o.title);
    return { ...base, status: candidates.length ? "changed" : "no_candidate", candidates, pageUpdatedAt: page.updatedAt };
  });
}

/** 把候選姓名寫回對照表：只改那一筆，英文姓名與任期清空（屬於前任），附註待人工確認。 */
export function applyCandidates(source, results, today) {
  let out = source;
  for (const r of results.filter((x) => x.status === "changed")) {
    const start = out.indexOf(`path: "${r.path}"`);
    if (start < 0) continue;
    const blockStart = out.lastIndexOf("{", start);
    const blockEnd = out.indexOf("\n  },", start);
    const block = out.slice(blockStart, blockEnd);
    const unit = /unit: "([^"]+)"/.exec(block)?.[1];
    const titleEn = /titleEnSearch: (\[[^\]]*\])/.exec(block)?.[1] ?? "[]";
    const replacement =
      `{\n    path: "${r.path}", unit: "${unit}", title: "${r.title}", name: "${r.candidates[0]}",\n` +
      `    note: "${today} 自動偵測換人（前任：${r.oldName ?? "無中文姓名"}），候選姓名待人工確認；英文姓名、任期待補",\n` +
      `    titleEnSearch: ${titleEn},`;
    out = out.slice(0, blockStart) + replacement + out.slice(blockEnd);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const { OFFICIALS } = await import("../src/ingestion/officials.ts");
  const pages = await fetchPages([...new Set(OFFICIALS.map((o) => o.path))]);
  const results = checkOfficials(OFFICIALS, pages);
  const today = new Date().toISOString().slice(0, 10);
  for (const r of results.filter((x) => x.status !== "ok")) {
    console.log(`${r.status}\t${r.title}\t${r.oldName ?? "-"} → ${r.candidates.join("、") || "（無候選）"}\t${r.url}`);
  }
  console.log(`checked ${results.length}, changed ${results.filter((r) => r.status !== "ok").length}`);
  const reportAt = args.indexOf("--report");
  if (reportAt >= 0) writeFileSync(args[reportAt + 1], JSON.stringify({ today, results }, null, 2));
  if (args.includes("--write")) {
    const src = readFileSync(TABLE, "utf8");
    const next = applyCandidates(src, results, today);
    if (next !== src) writeFileSync(TABLE, next);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
