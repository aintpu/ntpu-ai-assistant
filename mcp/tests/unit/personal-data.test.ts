import { describe, expect, it } from "vitest";
import { personalDataReason } from "../../src/ingestion/personal-data";

describe("personal data guard", () => {
  it.each([
    ["masked with O", "合格名單", "高O琁"],
    ["masked with 〇", "英語能力檢定獎勵結果公告", "王〇明\t李〇華\t陳〇安"],
    ["masked with ○ and no list title", "國際志工培訓招募", "錄取：林○宇、張○婷、黃○誠"],
    ["masked with x", "抽獎結果", "吳x豪 周x妤 蔡x勳"],
    ["full student ids", "問卷抽獎結果", "411234567 412345678 410987654"],
    ["partly masked student ids", "獲獎名單", "4xx***123\n41234****\n4101***88"],
    [
      "unmasked names under a list title",
      "EMI/ESAP教學助理合格名單",
      "陳怡君 林家豪 黃志明 張雅婷 李宗翰 王淑芬 吳承恩 劉建宏 蔡佳穎 楊子儀 許文彬",
    ],
  ])("blocks %s", (_name, title, text) => {
    expect(personalDataReason(title, text)).toMatch(/^PERSONAL_DATA/);
  });

  it.each([
    ["Chinese-numeral years", "活動公告", "二〇二六年三月舉辦，二〇二五年成果展。"],
    ["ordinary announcements", "英文健診預約名單", "請至英文健診系統查詢預約時段，名單請見附件圖片。"],
    ["name-like words without a list title", "課程介紹", "陳列 林園 黃金 張貼 李子 王牌 吳郭魚 劉海 蔡倫 楊柳 許多 高等"],
    ["phone numbers and dates", "多益校園考報名", "電話 02-86741111 分機 66701，日期 2026/10/03。"],
  ])("does not block %s", (_name, title, text) => {
    expect(personalDataReason(title, text)).toBeNull();
  });
});
