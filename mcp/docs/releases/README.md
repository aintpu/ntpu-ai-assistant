# 上線紀錄（Release records）

每次部署 production 新增一個檔案 `YYYY-MM-DD-<簡述>.md`，內容：

```markdown
# <日期> <簡述>

| 項目 | 值 |
|---|---|
| Git commit | <main 上的合併 SHA> |
| PR | #<n> |
| ntpu-aia-ingest 版本 | <Worker version ID> |
| ntpu-aia-mcp 版本 | <Worker version ID> |
| D1 migration | <有/無，檔名> |
| 部署者 / 時間（台北） | <姓名> / <時間> |

## 變更
## 驗證（smoke 結果與證據）
## 還原方式
## 已知問題
```

Worker version ID 用 `npx wrangler deployments list --name <worker>` 查。
