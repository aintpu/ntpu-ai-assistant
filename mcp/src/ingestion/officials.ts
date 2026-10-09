/**
 * 現任主管對照表（老師建議 二-1、一-1-(2)）。2026-10-09 人工逐頁核對各主管介紹頁（new.ntpu.edu.tw + path）後填寫。
 * - name：頁面上載明的中文姓名；每次抓取都會確認仍在頁面上，不在了（換人或改版）該筆就不再提供，需要人工重新核對。
 * - nameEn：統一寫法；nameEnOfficial：官網英文頁（content_en）上的原文寫法，每次抓取都確認仍在英文頁上。
 *   英文頁寫「待補」、內容是中文、或寫的是前任時留空，不自行以拼音補上。
 * - term：只採用頁面寫明的任期，沒寫就留空。
 * - unit：MCP 處室代碼；titleEnSearch 是英文職稱的常見說法，只供比對英文提問。
 * 不從公文的「校長核定」或簽名欄推定任何人的職務。
 */
export interface OfficialEntry {
  path: string;
  unit: string;
  title: string;
  name: string | null;
  nameEn?: string;
  nameEnOfficial?: string;
  term?: string;
  termSource?: string;
  note?: string;
  titleEnSearch: string[];
}

export const OFFICIALS: readonly OfficialEntry[] = [
  {
    path: "/president", unit: "president", title: "校長", name: "林道通",
    nameEn: "Dalton Daw-Tung Lin", nameEnOfficial: "DR. DALTON DAW-TUNG, LIN",
    term: "2025至今", termSource: "校長介紹頁行政經歷：國立臺北大學 校長 2025至今",
    titleEnSearch: ["president"],
  },
  {
    path: "/vice-president-academic", unit: "vice-president-academic", title: "學術副校長", name: "陳宥杉",
    nameEn: "Yu-Shan Chen", nameEnOfficial: "DR.YU-SHAN CHEN",
    titleEnSearch: ["vice president for academic affairs", "academic vice president"],
  },
  {
    path: "/vice-president-administration", unit: "vice-president-administration", title: "行政副校長", name: "張玉山",
    nameEn: "Yue-Shan Chang", nameEnOfficial: "CHANG YUE-SHAN",
    titleEnSearch: ["vice president for administrative affairs", "vice president for administration", "administrative vice president"],
  },
  {
    path: "/vice-president-financial", unit: "vice-president-financial", title: "財務暨永續發展副校長", name: "朱炫璉",
    nameEn: "Hsuan-Lien Chu", nameEnOfficial: "DR. Hsuan-Lien Chu",
    titleEnSearch: ["vice president for finance", "vice president for finance and sustainable development"],
  },
  {
    path: "/oaa/director", unit: "oaa", title: "教務長", name: "陳婉琪",
    nameEn: "Wan-Chi Chen", nameEnOfficial: "Chen, Wan-Chi",
    term: "2025至今", termSource: "教務長介紹頁：國立臺北大學教務長(2025至今)",
    titleEnSearch: ["dean of academic affairs"],
  },
  {
    path: "/osa/director", unit: "osa", title: "學務長", name: "胡中宜",
    nameEn: "Chung-Yi Hu", nameEnOfficial: "CHUNG-YI HU",
    titleEnSearch: ["dean of student affairs"],
  },
  {
    path: "/oga/director", unit: "oga", title: "總務長", name: "王佳惠",
    nameEn: "Chia-Hui Wang", nameEnOfficial: "Dr. Chia-Hui Wang",
    term: "2025.08至今", termSource: "總務長介紹頁：國立臺北大學總務長 2025.08~迄今",
    titleEnSearch: ["dean of general affairs"],
  },
  {
    path: "/ord/director", unit: "ord", title: "研發長", name: "陳裕賢",
    nameEn: "Yuh-Shyan Chen", nameEnOfficial: "Yuh-Shyan Chen",
    term: "2025.8起", termSource: "研發長介紹頁：國立臺北大學研究發展處研發長 2025.8起",
    titleEnSearch: ["dean of research and development", "dean of research"],
  },
  {
    path: "/oia/director", unit: "oia", title: "國際長", name: null,
    nameEn: "Thijs A. Velema", nameEnOfficial: "Thijs A. Velema",
    note: "官網只有英文姓名",
    titleEnSearch: ["dean of international affairs"],
  },
  {
    path: "/os/secretary-general", unit: "os", title: "主任秘書", name: "胡龍騰",
    nameEn: "Lung-Teng Hu", nameEnOfficial: "Lung-Teng Hu",
    titleEnSearch: ["secretary general", "chief secretary"],
  },
  {
    path: "/oa/director", unit: "oa", title: "主計室主任", name: "王兼善",
    note: "英文頁為其他人姓名（未更新），英文姓名留空",
    titleEnSearch: ["director of accounting office", "chief accountant"],
  },
  {
    path: "/library/director", unit: "library", title: "圖書館館長", name: "呂育誠",
    note: "英文頁待補，英文姓名留空",
    titleEnSearch: ["library director", "university librarian"],
  },
  {
    path: "/cic/director", unit: "cic", title: "資訊中心主任", name: "汪志堅",
    nameEn: "Chih-Chien Wang", nameEnOfficial: "CHIH-CHIEN WANG",
    titleEnSearch: ["director of computer and information center"],
  },
  {
    path: "/cge/director", unit: "cge", title: "通識教育中心主任", name: "王冠生",
    note: "英文頁內容為中文，英文姓名留空",
    titleEnSearch: ["director of center for general education"],
  },
  {
    path: "/ope/director", unit: "ope", title: "體育室主任", name: "吳慧卿",
    nameEn: "Hui-Ching Wu", nameEnOfficial: "Hui-Ching Wu",
    titleEnSearch: ["director of physical education office"],
  },
  {
    path: "/eec/director", unit: "eec", title: "進修暨推廣部主任", name: "蔡顯童",
    note: "英文頁待補，英文姓名留空",
    titleEnSearch: ["director of division of continuing and extension education"],
  },
  {
    path: "/alumni/director", unit: "alumni", title: "校友服務中心主任", name: "葉淑玲",
    nameEn: "Shu-Ling Yeh", nameEnOfficial: "Shu-Ling Yeh",
    titleEnSearch: ["director of alumni center"],
  },
  {
    path: "/edusp/director", unit: "edusp", title: "高教深耕計畫辦公室主任", name: "陳婉琪",
    note: "英文頁為前任主任（未更新），英文姓名留空",
    titleEnSearch: ["director of higher education sprout project office"],
  },
];
