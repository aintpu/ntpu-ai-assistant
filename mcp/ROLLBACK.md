# MCP 合併還原說明

對象：PR #1「feat(mcp): 新增 NTPU AIA MCP 資料線」
https://github.com/aintpu/ntpu-ai-assistant/pull/1

## 備份點

合併前的 `main` 已備份，兩者都指向 `a7957e4`：

| 類型 | 名稱 | 連結 |
|---|---|---|
| tag | `main-before-mcp-20261003` | https://github.com/aintpu/ntpu-ai-assistant/releases/tag/main-before-mcp-20261003 |
| 分支 | `backup/main-before-mcp` | https://github.com/aintpu/ntpu-ai-assistant/tree/backup/main-before-mcp |

PR #1 已於 2026-10-03 23:17（台北）以 merge commit 合併：

| 項目 | 值 |
|---|---|
| 合併 commit | `d07cd486eb5b0079c33ace2424cd603dd54f78ef` |
| 第一 parent（原本的 main） | `a7957e4` |
| 第二 parent（MCP 分支） | `ab77ba1` |

合併後只觸發了 `mcp-ci.yml`，`deploy.yml`（正式站）沒有被觸發。

---

## 方法一（建議）：Revert 合併 commit

不改寫歷史，所有紀錄都保留，不需要 force push。

### 在 GitHub 上操作

1. 打開 PR #1：https://github.com/aintpu/ntpu-ai-assistant/pull/1
2. 頁面下方合併紀錄旁按 **Revert**
3. GitHub 會開一個新的 revert PR，確認內容後按合併
4. 合併完成後，`main` 的內容回到合併前的狀態

### 或用指令

```bash
git fetch origin
git switch -c revert-mcp origin/main
git revert -m 1 d07cd486eb5b0079c33ace2424cd603dd54f78ef   # -m 1 表示保留 main 這一側（a7957e4）
git push origin revert-mcp
# 接著在 GitHub 開 PR：revert-mcp → main
```

### 注意

- Revert 只會移除 `mcp/`、兩個 MCP workflow，以及 `README.md` 新增的 3 行。這些都不在 `deploy.yml` 的觸發路徑內，**不會觸發正式站部署**。
- Revert 之後如果想再合併同一個分支，要先「revert 那個 revert commit」，直接重新合併不會把檔案帶回來。

---

## 方法二（緊急）：把 main 重設回 tag

⚠️ **這需要 force push，會改寫 `main` 的歷史。執行前一定要先確認。**

只在方法一無法使用時才用，例如 main 壞到無法開 PR。

### 執行前先檢查

```bash
git fetch origin --tags
# 列出合併之後又進到 main 的 commit；重設會讓這些 commit 全部消失
# 如果只有 PR #1 的內容，最新一筆應該是 d07cd48（合併 commit）
git log --oneline main-before-mcp-20261003..origin/main
git rev-parse origin/main   # 剛合併完時應為 d07cd486eb5b0079c33ace2424cd603dd54f78ef
```

如果 `origin/main` 已經不是 `d07cd48`，代表合併之後又有其他 commit：

- 那些 commit 會被一起移除，要先跟提交的人確認
- 如果其中有改到 `deploy.yml` 觸發路徑的檔案（例如 `cf/`、`agentic_v2_5_4high.py`），重設後的 push 會**觸發正式站重新部署**

### 指令

```bash
# 把下面的 <目前 main 的 SHA> 換成 git rev-parse origin/main 的結果。
# --force-with-lease 確保 main 沒有在你檢查之後又被別人更新；如果有，push 會被拒絕。
git push --force-with-lease=main:<目前 main 的 SHA> \
  origin 'main-before-mcp-20261003^{commit}:refs/heads/main'
```

如果 `main` 有分支保護（不允許 force push），要先到 GitHub 的 Settings → Branches 暫時解除，完成後記得恢復。

---

## 如果 production Worker 有問題

> 目前 **還沒有部署 production**。以下是之後部署 production 後的處理方式。

正式環境的 Worker 名稱是 `ntpu-aia-ingest`（抓取）和 `ntpu-aia-mcp`（查詢）。staging 是 `ntpu-aia-ingest-staging` 和 `ntpu-aia-mcp-staging`，用法相同。以下指令都在 `mcp/` 目錄執行。

還原 Git 不會影響已經部署上去的 Worker，Worker 要另外處理。

### 方法 A：退回上一版

```bash
cd mcp
# 列出部署紀錄，找到要退回的版本 ID
npx wrangler deployments list --name ntpu-aia-ingest

# 退回指定版本（不帶版本 ID 則退回上一版）
npx wrangler rollback <版本 ID> --name ntpu-aia-ingest -m "退回原因"

# MCP Worker 同樣做法
npx wrangler deployments list --name ntpu-aia-mcp
npx wrangler rollback <版本 ID> --name ntpu-aia-mcp -m "退回原因"
```

注意：rollback 只退回程式碼，**不會**還原 D1 的資料或已執行的 migration。

### 方法 B：停用排程

如果問題出在排程抓取（例如一直失敗、對學校網站造成負擔），先停止抓取最快：

- **Dashboard**：Workers & Pages → `ntpu-aia-ingest` → Settings → Triggers → 刪除 Cron Trigger
- **指令**：把 `wrangler.ingest.jsonc` 裡 `env.production` 的 `"crons"` 改成 `[]`，再執行：

```bash
cd mcp
npx wrangler triggers deploy --env production --config wrangler.ingest.jsonc
```

停用排程後，MCP Worker 仍然可以查詢已經存進 D1 的資料，只是不會再更新。
`/health` 會隨時間顯示 `stale`，這是正常的。

要恢復時，把 cron 改回 `["*/10 * * * *"]` 再部署一次即可。
