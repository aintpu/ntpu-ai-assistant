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
