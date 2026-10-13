# ADR-0011：加入資訊管理研究所網站

日期：2026-10-13

## 背景
使用者指定加入北大資管所（https://www.mis.ntpu.edu.tw/）。網站是 WordPress，robots.txt 允許爬取；
REST API（/wp-json/wp/v2/*）回 401 需要登入，不能使用。

## 決定
- `mis-announcements`（html-news，site `mis-wp`）：列表用公開的 `wp-sitemap-posts-post-1.xml`（約 224 則），
  文章網址 `/YYYY/MM/DD/slug/` 以 pathRules 限定格式；刊登日期取自網址（內文頁沒有 article:published_time）。
  編號 = `mis` + 日期 + 網址 FNV-1a 雜湊。每次最多抓 60 則，30 天重新驗證。
- `mis-site-pages`（html-pages，site `mis`）：23 個固定頁面（不含首頁、最新消息等列表頁；/eng/ 會轉址，不收）。
  頁面沒有公開修改時間，updatedAt 留空。
- 請求間隔 1 秒，不跟隨轉址；sitemap 的 content-type 是 application/xml，只有這兩個來源接受。
- AIA 新增只有 MCP 資料的單位 `mis`。
