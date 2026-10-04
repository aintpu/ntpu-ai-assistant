#!/usr/bin/env node
// 把人工整理檔上傳到 R2 的 manual/，抓取 Worker 下一次排到這些來源時就會讀取、比對、寫入 D1。
//
//   node scripts/upload-manual.mjs --env staging            上傳到 ntpu-aia-raw-staging
//   node scripts/upload-manual.mjs --env production         上傳到 ntpu-aia-raw
//   node scripts/upload-manual.mjs --env staging --dry-run  只產生 JSON、列出要上傳的檔案
//
// markdown 原樣上傳；兩份法規彙整 xlsx 轉成 derived/regulation-catalog.json（只轉格式，內容照原表）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegulationCatalog, CATALOG_PATH, MANUAL_MARKDOWN } from "./manual-files.mjs";

const BUCKETS = { staging: "ntpu-aia-raw-staging", production: "ntpu-aia-raw" };

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const env = envIndex >= 0 ? args[envIndex + 1] : undefined;
const dryRun = args.includes("--dry-run");
if (!env || !(env in BUCKETS)) {
  console.error("用法：node scripts/upload-manual.mjs --env staging|production [--dry-run]");
  process.exit(2);
}

const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(mcpDir, "..");
const wrangler = join(mcpDir, "node_modules", ".bin", "wrangler");

const missing = MANUAL_MARKDOWN.filter((f) => !existsSync(join(repoRoot, f)));
if (missing.length) {
  console.error(`找不到檔案：${missing.join(", ")}`);
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), "ntpu-manual-"));
try {
  const catalog = buildRegulationCatalog(repoRoot);
  const catalogFile = join(workDir, "regulation-catalog.json");
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`法規彙整表：${catalog.rows.length} 列 → ${CATALOG_PATH}`);

  const uploads = [
    ...MANUAL_MARKDOWN.map((f) => ({ key: f, file: join(repoRoot, f), type: "text/markdown; charset=utf-8" })),
    { key: CATALOG_PATH, file: catalogFile, type: "application/json" },
  ];

  for (const u of uploads) {
    const target = `${BUCKETS[env]}/manual/${u.key}`;
    if (dryRun) {
      console.log(`[dry-run] ${target}`);
      continue;
    }
    const r = spawnSync(wrangler, ["r2", "object", "put", target, "--file", u.file, "--content-type", u.type, "--remote"], {
      cwd: mcpDir,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      console.error(`上傳失敗：${target}\n${r.stderr || r.stdout}`);
      process.exit(1);
    }
    console.log(`已上傳 ${target}`);
  }
  console.log(dryRun ? "（dry-run，未上傳）" : `完成，共 ${uploads.length} 個檔案。`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
