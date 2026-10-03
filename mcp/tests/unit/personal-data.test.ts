import { describe, expect, it } from "vitest";
import { personalDataReason } from "../../src/ingestion/personal-data";

describe("personal data guard", () => {
  it.each([
    ["masked with O", "合格名單", "高O琁"],
    ["masked with 〇", "英語能力檢定獎勵結果公告", "王〇明\t李〇華\t陳〇安"],
    ["masked with ○ and no list title", "國際志工培訓招募", "錄取：林○宇、張○婷、黃○誠"],
    ["full student ids", "問卷抽獎結果", "411234567 412345678 410987654"],
    ["partly masked student ids", "獲獎名單", "4xx***123\n41234****\n4101***88"],
    [
      "unmasked names under a list title",
      "EMI/ESAP教學助理合格名單",
      "陳怡君 林家豪 黃志明 張雅婷 李宗翰 王淑芬 吳承恩 劉建宏 蔡佳穎 楊子儀 許文彬",
    ],
    [
      "student names followed by 同學",
      "【得獎名單】通識月徵件競賽評審結果",
      "第一名 法律學系 陳怡君 同學\n第二名 經濟學系林家豪同學\n佳作 社工系 黃志明 同學",
    ],
    ["teacher names followed by 老師", "獲選優良通識教育教師名單", "張雅婷 老師、李宗翰老師、王淑芬 教授"],
  ])("blocks %s", (_name, title, text) => {
    expect(personalDataReason(title, text)).toMatch(/^PERSONAL_DATA/);
  });

  it.each([
    ["Chinese-numeral years", "活動公告", "二〇二六年三月舉辦，二〇二五年成果展。"],
    ["ordinary announcements", "英文健診預約名單", "請至英文健診系統查詢預約時段，名單請見附件圖片。"],
    ["name-like words without a list title", "課程介紹", "陳列 林園 黃金 張貼 李子 王牌 吳郭魚 劉海 蔡倫 楊柳 許多 高等"],
    ["phone numbers and dates", "多益校園考報名", "電話 02-86741111 分機 66701，日期 2026/10/03。"],
    ["numbers inside image file names", "培力講座", "S__412345678.jpg 412345679_n.jpg img-412345670.png"],
    ["x used as a connector or in X光", "活動轉知", "育X臺交流、講x國際論壇、用X光檢查、陳x林合作"],
    ["同學/老師 without names", "得獎名單公告", "恭喜全體同學，感謝各位老師與指導教授協助。"],
    ["titled names without a list title", "講座資訊", "主講：陳怡君老師、林家豪教授、黃志明老師"],
  ])("does not block %s", (_name, title, text) => {
    expect(personalDataReason(title, text)).toBeNull();
  });
});
