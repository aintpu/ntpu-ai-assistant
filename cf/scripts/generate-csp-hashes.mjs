// wrangler build 步驟（見 wrangler.jsonc 的 build.command）：每次 deploy／dev 前
// 掃描前端靜態輸出，產生 src/csp-hashes.generated.js，讓 CSP 以 hash 授權
// Next.js 的 inline script 與 inline style，而不需要 'unsafe-inline'。
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { cspHash, extractInline, findBlockedInlineAttributes } from "./csp-hashes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../front_end/sports-ai-chat/out");
const target = join(here, "../src/csp-hashes.generated.js");

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  }));
  return files.flat();
}

const files = await htmlFiles(outDir).catch((error) => {
  throw new Error(`找不到前端靜態輸出 ${outDir}，請先執行 front_end 的 npm run build（${error.message}）`);
});
if (!files.some((file) => file.endsWith("index.html"))) {
  throw new Error(`${outDir} 缺少 index.html，請先 build 前端`);
}

const scriptHashes = new Set();
const styleHashes = new Set();
const problems = [];
for (const file of files.sort()) {
  const html = await readFile(file, "utf8");
  const { scripts, styles } = extractInline(html);
  scripts.forEach((text) => scriptHashes.add(cspHash(text)));
  styles.forEach((text) => styleHashes.add(cspHash(text)));
  for (const problem of findBlockedInlineAttributes(html)) {
    problems.push(`${relative(outDir, file)}: ${problem}`);
  }
}

if (problems.length) {
  throw new Error(
    "以下寫法會被 CSP 擋掉（style=\"\"、onclick=\"\"、javascript: 無法用 hash 授權），請改用 class／addEventListener：\n  "
      + problems.join("\n  "),
  );
}
if (scriptHashes.size === 0) {
  throw new Error("前端輸出中沒有任何 inline script，與 Next.js 靜態輸出的預期不符，停止部署以免 CSP 設定錯誤");
}

const body = `// 由 cf/scripts/generate-csp-hashes.mjs 自動產生，請勿手動修改。
// 來源：front_end/sports-ai-chat/out（${files.length} 個 HTML）
export const SCRIPT_HASHES = ${JSON.stringify([...scriptHashes].sort(), null, 2)};
export const STYLE_HASHES = ${JSON.stringify([...styleHashes].sort(), null, 2)};
`;

const previous = await readFile(target, "utf8").catch(() => "");
if (previous !== body) await writeFile(target, body);
console.log(`[csp] ${files.length} HTML files → ${scriptHashes.size} script hashes, ${styleHashes.size} style hashes`);
