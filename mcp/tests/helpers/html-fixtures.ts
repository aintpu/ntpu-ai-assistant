import { makePdf } from "./attachment-fixtures";
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
/** 把一般物件編成 Nuxt 的 __NUXT_DATA__（devalue：每個值放進陣列、以索引互相參照）。 */
function nuxtPage(data: Record<string, unknown>): string {
  const arr: unknown[] = [];
  const put = (v: unknown): number => {
    const i = arr.length;
    arr.push(null);
    if (Array.isArray(v)) arr[i] = v.map(put);
    else if (v && typeof v === "object") arr[i] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)]));
    else arr[i] = v ?? null;
    return i;
  };
  put({ data });
  return `<html><body><div id="__nuxt"></div><script type="application/json" id="__NUXT_DATA__" data-ssr="true">${JSON.stringify(arr)}</script></body></html>`;
}

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
      // 商學院：最新消息列表只連到 3 號；2 號是已刪除的空白頁；內容頁每組一個分頁。
      // 金融科技中心在 /fintech/ 子目錄，同一套版型（列表是 /fintech/index.php）
      const main = (inner: string) => `<html><body><div role="main" class="main">${inner}</div></body></html>`;
      const path = url.pathname.replace(/^\/fintech(?=\/)/, "");
      if (path === "/news.php" || (path === "/index.php" && path !== url.pathname)) return html(main(`<a href="view.php?id=${btoa("3")}">最新</a>`));
      if (path === "/view.php") {
        const n = Number(atob(url.searchParams.get("id") ?? ""));
        if (n === 2) return html(main(`<div class="blog-posts"><h3>最新消息</h3></div>`));
        return html(main(`<div class="blog-posts"><h3>最新消息</h3><article class="post"><div class="post-content"><h3>商學院公告 ${n}</h3></div></article><p>商學院第 ${n} 則公告內文。</p><p>刊登時間：2026-10-0${n} 10:00:00</p></div>`));
      }
      if (path === "/page.php") {
        const g = url.searchParams.get("id");
        return html(main(`<ul class="nav nav-tabs"><li class="active"><a href="#t1">第 ${g} 組</a></li></ul><div class="tab-pane active" id="t1">${"商學院介紹內容。".repeat(10)}</div>`));
      }
    }
    if (["www.dba.ntpu.edu.tw", "coop.ntpu.edu.tw", "www.stat.ntpu.edu.tw", "www.acc.ntpu.edu.tw", "lsm.ntpu.edu.tw", "giib.ntpu.edu.tw", "www.dma.ntpu.edu.tw", "iemba.ntpu.edu.tw"].includes(url.hostname)) {
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
    if (url.hostname === "www.gmba.ntpu.edu.tw") {
      // GMBA（JSP）：最新消息一頁兩則；內容頁都回同一個版型
      const page = (title: string, body: string) =>
        `<html><body><div class="right"><div class="right_title"><h1> ${title}</h1></div><div class="text_area">${body}</div></div></body></html>`;
      if (url.pathname === "/web/news/news.jsp") {
        return html(
          `<div class="list"><div class="list_in"><div class="title"><a href="news_in.jsp?np_id=NP1791882343315"> 公告一</a></div></div></div>` +
            `<div class="list"><div class="list_in"><div class="title"><a href="https://example.com/x"> 外部連結</a></div></div></div>`,
        );
      }
      if (url.pathname === "/web/news/news_in.jsp") return html(page(`GMBA 公告 ${url.searchParams.get("np_id")}`, "<p>GMBA 公告內文。</p>"));
      return html(page("GMBA 頁面", "財務金融英語碩士學位學程介紹。".repeat(10)));
    }
    if (url.hostname === "ebrc.gm.ntpu.edu.tw") {
      return html(
        `<html><body><section><div role="main"><h1>工作計畫</h1></div></section><section>${"電子商務研究中心工作計畫。".repeat(10)}</section></body></html>`,
      );
    }
    if (url.hostname === "ccs.ntpu.edu.tw") {
      if (url.pathname === "/backend/data.json") {
        return new Response(
          JSON.stringify({
            news: [{ id: 27, title: "永續公告", date: "2024-11-05", content: "永續公告內文\n第二段" }],
            team: {
              center_members: [{ name: "王小明 教授", position: "主任", email: "x@gm.ntpu.edu.tw", bio: "國立臺北大學金融與合作經營學系特聘教授，研究永續金融。" }],
              advisors: [{ name: "李大華 博士", position: "諮詢顧問", phone: "(02)86741111分機66971" }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return html(`<html><head><title>企業永續頁面 - NTPU CCS</title></head><body><header>頁首</header><main>${"企業永續發展研究中心介紹。".repeat(10)}</main><footer>頁尾</footer></body></html>`);
    }
    if (url.hostname === "econ.ntpu.edu.tw") {
      // 經濟系 Rpage：所有公告（分類 32）兩則；選單頁 111 有一個以 ajax 載入的分頁區塊
      const row = (n: number, date: string) =>
        `<div class="mtitle">${date ? `<i class="mdate before">${date}</i>` : ""}<a href="https://econ.ntpu.edu.tw/p/406-1001-${n},r12.php?Lang=zh-tw">經濟系公告 ${n}</a></div>`;
      const list = (rows: string) => `<script>var o={totalPage:1}</script><div class="module module-rcglist"><section class="mb">${rows}</section></div>`;
      if (url.pathname === "/p/403-1001-32-1.php") return html(list(row(1384, "2026-10-14") + row(1381, "2026-10-01")));
      const detail = /^\/p\/406-1001-(\d+)\.php$/.exec(url.pathname);
      if (detail) {
        return html(`<div class="mpgtitle"><h2 class="hdline">經濟系公告 ${detail[1]}</h2></div><div class="mpgdetail"><div class="meditor"><p>經濟系公告內文。</p><iframe src="/var/file/1/1001/img/1.pdf"></iframe></div></div>`);
      }
      if (url.pathname === "/app/index.php") {
        if (request.method !== "POST" || !(request.headers.get("referer") ?? "").startsWith("https://econ.ntpu.edu.tw/p/412-1001-")) {
          return new Response("", { status: 404 });
        }
        return html(`<div class="module"><h2 class="mt-title">相關辦法 - 組織章程</h2><ul><li><a href="/var/file/1/1001/img/2.pdf">經濟學系學生事務委員會組織章程</a></li><li><a href="/var/file/1/1001/img/3.pdf">經濟學系系務會議組織章程</a></li><li><a href="/var/file/1/1001/img/4.pdf">經濟學系課程委員會組織章程</a></li></ul></div>`);
      }
      if (url.pathname.startsWith("/p/412-1001-")) {
        const tabs = url.pathname === "/p/412-1001-111.php"
          ? `<div class="module module-complex"><nav><ul><li><a href="#cmb_12_0">組織章程</a></li></ul></nav><div class="tab-content"><div class="tab-pane" id="cmb_12_0"><script>$.hajaxOpenUrl('/app/index.php?Action=mobileloadmod&Type=mobile_mnu_mstr&Nbr=39','#x')</script></div></div></div>`
          : `<div class="module module-cglist"><div class="meditor">${"經濟學系介紹內容。".repeat(10)}</div></div>`;
        return html(`<html><head><title>經濟系頁面 </title></head><body><main><div class="module module-path">首頁 > 頁面</div>${tabs}<div class="module module-misc">友善列印</div></main></body></html>`);
      }
    }
    if (url.hostname === "sociology.ntpu.edu.tw") {
      // 社會系 Nuxt：每個分類第一頁一則公告（第 8 類是外部連結）；內容頁都回同一份分類內容
      const cate = Number(url.searchParams.get("cate") ?? 0);
      if (url.pathname === "/news") {
        const item = cate === 8
          ? { id: 900, urltag: "ExtLink0001", title: "外部連結", post_date: "2026-11-01", url: "https://example.com" }
          : { id: 580 + cate, urltag: `TagNews${cate}00`, title: `社會系公告 ${cate}`, post_date: `2026-10-0${cate}`, url: null };
        return html(nuxtPage({ "resListzh-TW": { data: [item], total: 1 } }));
      }
      const news = /^\/news\/(TagNews\d00)$/.exec(url.pathname);
      if (news) {
        return html(nuxtPage({ "resDatazh-TW": { data: { title: `社會系公告 ${news[1]}`, post_date: "2026-10-01", content: [{ title: null, content: "<p>社會系公告內文。</p>" }] } } }));
      }
      if (url.pathname === "/teacher") {
        return html(nuxtPage({ "resCategoryzh-TW": { data: [{ id: 1, name: "專任教師" }] }, "resListzh-TW": { data: [{ name: "王社會", title: "教授", school: "國立臺灣大學社會學博士", phone: "67100", email: "a@gm.ntpu.edu.tw", skillName: "社會階層、社會研究方法" }] } }));
      }
      if (url.pathname.startsWith("/page/")) {
        return html(nuxtPage({ customDatanCCvQttlhMCN: { data: { name: "募款專區", content: [{ title: null, content: `<p>${"支持社會系發展。".repeat(10)}</p>` }] } } }));
      }
      return html(
        nuxtPage({
          dataType: { data: { name: "系所介紹" } },
          dataCategory: { data: [{ id: cate || 1, name: "沿革與現況", content: [{ title: "本系沿革", content: `<p>${"社會學系介紹內容。".repeat(10)}</p>` }], files: [] }] },
          dataList: { data: [{ title: "碩士論文一", sub_title: null, date_at: "2026-09-09 00:00:00", files: [{ title: "論文摘要", file_path: "https://sociology.ntpu.edu.tw/storage/media/a.pdf" }] }] },
        }),
      );
    }
    if (url.hostname === "www.sw.ntpu.edu.tw" || url.hostname === "crm.ntpu.edu.tw") {
      // 社工系（div#in_content、li 列表）與犯罪所（div.pageright、dl 列表）；第一個分類兩頁
      const sw = url.hostname.startsWith("www.sw");
      const q = url.searchParams;
      const wrap = (inner: string) => (sw ? `<div id="in_content">${inner}</div>` : `<div class="pageright"><ol class="breadcrumb"><li>首頁</li></ol>${inner}</div>`);
      const page = (title: string, inner: string) => `<html><head><title>${title}-國立臺北大學</title></head><body>${wrap(inner)}</body></html>`;
      const link = (id: number) => `${url.origin}/index.php?option=module&lang=cht&task=pageinfo&id=${id}`;
      if (q.get("task") === "showlist" && q.get("option") === "module" && ["5", "6", "7", "5430", "95", "78", "79"].includes(q.get("id")!)) {
        const list = Number(q.get("id"));
        const p = Number(q.get("pages") ?? 1);
        const n = list * 10 + p;
        const row = sw ? `<li><span class="date">2026-10-0${p}</span><a href="${link(n)}">公告 ${n}</a></li>` : `<dl><dt>2026-10-0${p}</dt><dd><a href="${link(n)}">公告 ${n}</a></dd></dl>`;
        const pager = list === 5 || list === 95 ? `<div class="pagenum"><a href="${url.origin}/index.php?option=module&lang=cht&task=showlist&id=${list}&pages=2">2</a></div>` : "";
        return html(page("最新消息", `${sw ? `<ul>${row}</ul>` : row}${pager}`));
      }
      if (q.get("task") === "pageinfo") {
        const id = q.get("id")!;
        const body = sw
          ? `<div class="newstitle02">公告 ${id}<h1>2026-10-01</h1></div><div class="edit"><p>${"系所公告內文。".repeat(10)}</p></div>`
          : `<div class="newslist3"><dl><dt>2026-10-01</dt><dd>公告 ${id}</dd></dl></div><div class="newscontent"><p>${"系所公告內文。".repeat(10)}</p></div><div class="newscontent_dl"><a href="${url.origin}/index.php?option=module&lang=cht&task=dfile&id=${id}&i=1" download="附件">附件</a></div>`;
        return html(page(`公告 ${id}`, body));
      }
      // 內容頁：課程資訊（社工系 38）是子頁連結清單
      if (sw && q.get("id") === "38") {
        return html(page("課程資訊", `<ul><li><a href="${link(7001)}">學士班課程</a></li><li><a href="https://www.sw.ntpu.edu.tw/index.php?option=module&lang=cht&task=showlist&id=21">系主任的話</a></li></ul>`));
      }
      return html(page("系所頁面", `<div class="edit">${"系所介紹內容。".repeat(10)}</div><div class="backbox">上一頁</div>`));
    }
    if (url.hostname === "cms-carrier.ntpu.edu.tw" && url.pathname === "/uploads/_531a116c2f.pdf") {
      return new Response(makePdf("Aging and Community Research Center introduction. ".repeat(4)), { headers: { "content-type": "application/pdf" } });
    }
    return new Response("unexpected host", { status: 599 });
  };
}
