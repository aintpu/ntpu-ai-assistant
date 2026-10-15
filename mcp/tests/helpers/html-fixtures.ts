/**
 * 依 2026-10-03 實際抓到的圖書館、語言中心頁面結構所寫的最小 HTML 樣本
 * （只保留 adapter 用到的元素與屬性，加上一些干擾用的外層結構）。
 */
export interface FakeNews {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  body: string;
  attachments?: { name: string; href: string }[];
  /** 列表上的連結改成外部網站（不是內文頁）。 */
  external?: boolean;
}

const LIB_SVC = "3c152b26c59f4dba96939df64e2edd2f";

export function libraryId(n: number): string {
  return n.toString(16).padStart(32, "a");
}

export function lcId(n: number): string {
  return `NP${String(1_790_000_000_000 + n)}`;
}

export function libraryListHtml(items: FakeNews[], page: number, totalPages: number, total: number): string {
  const rows = items
    .map(
      (n) => `<tr>
        <td data-title="標題："><a href="${
          n.external ? "https://www.canva.com/design/x" : `/singlehtml/${LIB_SVC};jsessionid=ABC123?cntId=${n.id}`
        }" title="${n.title}">${n.title}</a></td>
        <td data-title="發布日期："><span>${n.date}</span></td>
      </tr>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html><head><title>最新消息</title><script>var x = "<tr>";</script></head><body>
    <header><a href="/">首頁</a></header>
    <form><input type="hidden" name="csrfToken" value="t"></form>
    <table class="table-list"><thead><tr><th>標題</th><th>發布日期</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="pagination">第 ${page} 頁，總共 ${totalPages} 頁，${total} 筆資料</div>
  </body></html>`;
}

export function libraryDetailHtml(n: FakeNews): string {
  const files = (n.attachments ?? [])
    .map((f) => `<li><a href="${f.href}" title="下載：${f.name}">${f.name}</a></li>`)
    .join("");
  return `<!DOCTYPE html><html><body>
    <h2 class="h2-page-title">${n.title}</h2>
    <div class="info"><span>發布日期：${n.date}</span><span>上架者：讀者服務組 分機 1234</span></div>
    <article>${n.body}</article>
    ${files ? `<div class="attachment"><ul>${files}</ul></div>` : ""}
    <footer>更新日期: ${n.date}</footer>
  </body></html>`;
}

export function lcListHtml(items: FakeNews[], totalPages: number): string {
  const list = items
    .map(
      (n) => `<div class="list">
        <div class="img"><img src="/uploads/news/tw/a.jpg"></div>
        <div class="info"><div class="title"> ${n.title} </div><div class="date">${n.date.replaceAll("-", "/")}</div></div>
        <div class="more_btn"><a href="${n.external ? "https://forms.gle/x" : `../news/news_in.jsp?np_no=${n.id}`}">MORE</a></div>
      </div>`,
    )
    .join("\n");
  const pager = Array.from({ length: totalPages }, (_, i) => `<a href="javascript:goselectedpage(${i + 1})">${i + 1}</a>`).join("");
  return `<!DOCTYPE html><html><body>
    <div class="list_area">${list}</div>
    <div class="number_pageArea">${pager}</div>
  </body></html>`;
}

export function lcDetailHtml(n: FakeNews): string {
  const files = (n.attachments ?? []).map((f) => `<p><a href="${f.href}">${f.name}</a></p>`).join("");
  return `<!DOCTYPE html><html><body>
    <div class="titStyle1"><h2><!-- title -->${n.title}</h2></div>
    <div class="in_titStyle"><span>${n.date.replaceAll("-", "/")}</span></div>
    <section class="textArea">${n.body}${files}</section>
  </body></html>`;
}

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });

/** 模擬圖書館與語言中心網站；記錄收到的請求。 */
export class FakeSites {
  requests: string[] = [];
  constructor(
    public library: FakeNews[] = [],
    public lc: FakeNews[] = [],
  ) {}

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.hostname === "library.ntpu.edu.tw") {
      // 圖書館內容頁（library-web-pages）：列表型服務回一則，其餘單頁都回同一個版型
      if (!url.pathname.endsWith(LIB_SVC) && /^\/(single|multiple)html\//.test(url.pathname)) {
        const svc = url.pathname.split("/").pop()!;
        if (url.pathname.startsWith("/multiplehtml/") && request.method === "POST") {
          return html(`<p>總共 1 頁</p><table class="table-list"><tbody><tr><td data-title="標題："><a href="/singlehtml/${svc}?cntId=${"c".repeat(32)}" title="條目">條目</a></td></tr></tbody></table>`);
        }
        return html(`<h2 class="h2-page-title">圖書館頁面</h2><article>${"圖書館服務說明。".repeat(10)}</article>`);
      }
      if (url.pathname === `/multiplehtml/${LIB_SVC}`) {
        const page = Number(new URLSearchParams(await request.text()).get("page") ?? 1);
        const totalPages = Math.max(1, Math.ceil(this.library.length / 10));
        return html(libraryListHtml(this.library.slice((page - 1) * 10, page * 10), page, totalPages, this.library.length));
      }
      const item = this.library.find((n) => n.id === url.searchParams.get("cntId"));
      return item ? html(libraryDetailHtml(item)) : new Response("not found", { status: 404 });
    }
    if (url.hostname === "lc.ntpu.edu.tw") {
      // 語言中心內容頁（lc-site-pages）：同一個版型
      if (!url.pathname.startsWith("/web/news/")) {
        return html(`<div class="titStyle1"><h2>語言中心頁面</h2></div><div class="containerIn">${"語言中心課程與檢定說明。".repeat(10)}</div><div class="content">頁尾</div>`);
      }
      if (url.pathname === "/web/news/news.jsp") {
        const page = Number(url.searchParams.get("npage") ?? 1);
        const totalPages = Math.max(1, Math.ceil(this.lc.length / 6));
        return html(lcListHtml(this.lc.slice((page - 1) * 6, page * 6), totalPages));
      }
      const item = this.lc.find((n) => n.id === url.searchParams.get("np_no"));
      return item ? html(lcDetailHtml(item)) : new Response("not found", { status: 404 });
    }
    if (url.hostname === "www.aacsb.ntpu.edu.tw") {
      // 商學院：最新消息列表只連到 3 號；2 號是已刪除的空白頁；內容頁每組一個分頁
      const main = (inner: string) => `<html><body><div role="main" class="main">${inner}</div></body></html>`;
      if (url.pathname === "/news.php") return html(main(`<a href="view.php?id=${btoa("3")}">最新</a>`));
      if (url.pathname === "/view.php") {
        const n = Number(atob(url.searchParams.get("id") ?? ""));
        if (n === 2) return html(main(`<div class="blog-posts"><h3>最新消息</h3></div>`));
        return html(main(`<div class="blog-posts"><h3>最新消息</h3><article class="post"><div class="post-content"><h3>商學院公告 ${n}</h3></div></article><p>商學院第 ${n} 則公告內文。</p><p>刊登時間：2026-10-0${n} 10:00:00</p></div>`));
      }
      if (url.pathname === "/page.php") {
        const g = url.searchParams.get("id");
        return html(main(`<ul class="nav nav-tabs"><li class="active"><a href="#t1">第 ${g} 組</a></li></ul><div class="tab-pane active" id="t1">${"商學院介紹內容。".repeat(10)}</div>`));
      }
    }
    if (["www.dba.ntpu.edu.tw", "coop.ntpu.edu.tw", "www.stat.ntpu.edu.tw", "www.acc.ntpu.edu.tw"].includes(url.hostname)) {
      // 商學院所屬學系：首頁連到最新一則（企管系 nid 從 1000001 起編）；會計系最新消息直接在列表頁
      const main = (inner: string) => `<html><body><div role="main" class="main">${inner}</div></body></html>`;
      const nid = url.hostname.startsWith("www.dba");
      const first = nid ? 1_000_001 : 1;
      if (url.pathname === "/index.php") return html(main(`<a href="view.php?${nid ? "nid" : "id"}=${btoa(String(first + 1))}">最新</a>`));
      if (url.pathname === "/view.php") {
        const n = Number(atob(url.searchParams.get(nid ? "nid" : "id") ?? ""));
        return html(main(`<div class="blog-posts"><article class="post"><div class="post-content"><h3>學系公告 ${n}</h3><span>2026-10-0${n % 9 || 1}</span></div></article><p>學系公告內文。</p><center>預覽人數:${Date.now() % 1000}</center></div>`));
      }
      if (url.pathname === "/news.php" || url.pathname === "/r_news.php") {
        const n = url.pathname === "/news.php" ? 2004 : 1900 + Number(url.searchParams.get("tarea") ?? 0);
        return html(`<div class="modal" id="ssdefaultModal${n}"><h4 class="modal-title">會計系公告 ${n}</h4><div class="modal-body"><p>會計系公告內文。</p><p>刊登時間：2026-10-14 14:59:00</p></div></div>`);
      }
      if (url.pathname === "/page.php") {
        const g = url.searchParams.get("id");
        return html(main(`<ul class="nav nav-tabs"><li class="active"><a href="#t1">第 ${g} 組</a></li></ul><div class="tab-pane active" id="t1">${"學系介紹內容。".repeat(10)}</div>`));
      }
    }
    if (url.hostname === "www.mis.ntpu.edu.tw") {
      // 資管所 WordPress：sitemap 列 2 則文章；固定頁面都回同一個版型
      const page = (title: string, cls: string, body: string) =>
        `<html><body><nav>選單</nav><h1 class="entry-title">${title}</h1><div class="entry-content"><div class="${cls}">${body}</div></div></body></html>`;
      if (url.pathname === "/wp-sitemap-posts-post-1.xml") {
        return new Response(
          `<?xml version="1.0"?><urlset><url><loc>https://www.mis.ntpu.edu.tw/2026/10/06/intern/</loc></url><url><loc>https://www.mis.ntpu.edu.tw/2025/03/01/%e6%b4%bb%e5%8b%95/</loc></url></urlset>`,
          { headers: { "content-type": "application/xml; charset=UTF-8" } },
        );
      }
      const post = /^\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(url.pathname);
      if (post) return html(page(`資管所公告 ${post[1]}`, "post-content", "<p>資管所公告內文。</p>"));
      return html(page(`資管所頁面 ${url.pathname}`, "x", `${"資訊管理研究所介紹。".repeat(10)}`));
    }
    return new Response("unexpected host", { status: 599 });
  };
}
