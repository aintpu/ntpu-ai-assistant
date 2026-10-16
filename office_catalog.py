"""Additional FAQ-backed offices; no provider or indexing dependencies."""

# Existing seven offices keep their original identifiers and data sources.
FAQ_OFFICES = {
    "ord": ("研究發展處", "Office of Research and Development", ("研發處", "研究發展", "研究管理", "學術倫理", "研究倫理", "產學合作", "技術移轉", "專利申請", "國科會計畫", "研究計畫")),
    "oa": ("主計室", "Accounting Office", ("主計", "經費核銷", "經費報支", "經費結報", "差旅費", "預算分配", "會計", "支出憑證")),
    "lib": ("圖書館", "Library", ("圖書館", "借書", "還書", "續借", "館藏", "館際合作", "電子書", "自習室", "研究小間", "turnitin", "endnote", "ndds")),
    "cic": ("資訊中心", "Computer and Information Center", ("資訊中心", "校園網路", "校園無線", "校園授權軟體", "授權軟體", "vpn", "eduroam", "kms", "電子郵件", "電腦教室", "防毒", "帳號密碼")),
    "oia": ("國際事務處", "Office of International Affairs", ("國際處", "國際事務", "交換生", "赴外交換", "來校交換", "雙聯學位", "學海", "境外生", "國際學人", "鳶飛國際")),
    "eec": ("進修暨推廣部", "Division of Continuing and Extension Education", ("進修推廣", "進修暨推廣", "進修學士班", "推廣教育", "進修教育", "隨班附讀", "碩士在職專班")),
    "alu": ("校友中心", "Alumni Center", ("校友中心", "校友證", "校友會", "傑出校友", "校友電子報", "校友服務", "捐贈流程")),
    "sus": ("永續辦公室", "Sustainability Office", ("永續辦公室", "永續報告書", "永續發展目標", "sdgs", "usr", "碳盤查", "溫室氣體", "低碳運輸")),
    "edusp": ("高等教育深耕計畫辦公室", "Higher Education Sprout Project Office", ("高教深耕", "高等教育深耕", "深耕計畫", "深耕辦公室")),
    "os": ("秘書室", "Secretariat", ("秘書室", "主任秘書", "校務建言", "與校長有約", "校務會議", "校訊", "新聞聯繫")),
    "vpa": ("學術副校長室", "Office of the Vice President for Academic Affairs", ("學術副校長",)),
    "vpad": ("行政副校長室", "Office of the Vice President for Administrative Affairs", ("行政副校長",)),
    "vpf": ("財務暨永續發展副校長室", "Office of the Vice President for Finance and Sustainable Development", ("財務暨永續發展副校長", "財務副校長",)),
    "pres": ("校長室", "Office of the President", ("校長室", "校長", "現任校長", "校長學歷", "校長的研究", "president")),
}

# 只有 MCP 資料（官網公告、內容頁）、沒有 FAQ 檔的單位。不放進 FAQ_OFFICES（那裡的每個單位都要有
# crawler_data/<code>_faq.md 與 manifest）。2026-10-13 使用者指定加入商學院（www.aacsb.ntpu.edu.tw）
# 與資訊管理研究所（www.mis.ntpu.edu.tw）；2026-10-14 加入企管、金融、會計、統計四個學系。
MCP_ONLY_OFFICES = {
    "cob": ("商學院", "College of Business", ("商學院", "商院", "aacsb", "商學院院長", "商學院辦公室", "商學院公告")),
    "mis": ("資訊管理研究所", "Graduate Institute of Information Management",
            ("資訊管理研究所", "資管所", "北大資管", "資管所所長", "資管所教授", "資管所師資", "資管所招生", "資管所公告", "資管所修業")),
    "dba": ("企業管理學系", "Department of Business Administration",
            ("企業管理學系", "企管系", "北大企管", "企管系主任", "企管系老師", "企管系師資", "企管系招生", "企管系公告", "企管系修業")),
    "coop": ("金融與合作經營學系", "Department of Finance and Cooperative Management",
             ("金融與合作經營學系", "金融與合作經營", "金融系", "合經系", "金融系主任", "金融系老師", "金融系師資", "金融系招生", "金融系公告")),
    "acc": ("會計學系", "Department of Accountancy",
            ("會計學系", "會計系", "北大會計系", "會計系主任", "會計系老師", "會計系師資", "會計系招生", "會計系公告", "會計系修業")),
    "stat": ("統計學系", "Department of Statistics",
             ("統計學系", "統計系", "北大統計系", "統計系主任", "統計系老師", "統計系師資", "統計系招生", "統計系公告", "統計系修業")),
    # 2026-10-16 加入
    "lsm": ("休閒運動管理學系", "Department of Leisure and Sport Management",
            ("休閒運動管理學系", "休閒運動管理", "休運系", "休運系主任", "休運系老師", "休運系師資", "休運系招生", "休運系公告")),
    "giib": ("國際企業研究所", "Graduate Institute of International Business",
             ("國際企業研究所", "國企所", "國企所所長", "國企所老師", "國企所師資", "國企所招生", "國企所公告", "國企所課程")),
    "dma": ("數位行銷進修學士學位學程", "Bachelor Program of Digital Marketing",
            ("數位行銷進修學士學位學程", "數位行銷學程", "數位行銷學士學程", "數位行銷學位學程", "數位行銷學程主任", "數位行銷學程招生")),
}
MCP_ONLY_OFFICE_NAMES = {code: spec[0] for code, spec in MCP_ONLY_OFFICES.items()}

# 單位的上級（學系、研究所 → 學院）：寫進範圍判斷的提示詞，也供介紹頁依層級排列。新增系所時在這裡登記所屬學院。
OFFICE_PARENTS = {"mis": "cob", "dba": "cob", "coop": "cob", "acc": "cob", "stat": "cob", "lsm": "cob", "giib": "cob", "dma": "cob"}

# Offices whose retrieval also covers other offices' FAQ.  A question about
# the vice presidents without naming one routes to 校長室, so 校長室 searches
# the three vice-president offices as well and can list them all.
OFFICE_SEARCH_GROUPS = {
    "pres": ("pres", "vpa", "vpad", "vpf"),
}
VICE_PRESIDENT_TITLES = ("財務暨永續發展副校長", "財務副校長", "學術副校長", "行政副校長")

FAQ_OFFICE_NAMES = {code: spec[0] for code, spec in FAQ_OFFICES.items()}
FAQ_OFFICE_ALIASES = {
    alias.lower(): code
    for code, (zh, en, keywords) in FAQ_OFFICES.items()
    for alias in (code, zh, en, *keywords)
}
