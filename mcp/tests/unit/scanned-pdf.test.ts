import { unzlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { grayPng, toGray } from "../../src/ingestion/extract/scanned";

describe("掃描型 PDF 的頁面圖片", () => {
  it("encodes a valid grayscale PNG", () => {
    const png = grayPng(new Uint8Array([0, 255, 128, 64]), 2, 2);
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(2); // width
    expect(dv.getUint32(20)).toBe(2); // height
    const idatLen = dv.getUint32(33);
    const raw = unzlibSync(png.slice(41, 41 + idatLen));
    expect([...raw]).toEqual([0, 0, 255, 0, 128, 64]); // 每列前面一個 filter byte
  });

  it("converts RGB to gray and shrinks the long side to 2000 px", () => {
    const rgb = new Uint8Array(4000 * 10 * 3).fill(255);
    const g = toGray(rgb, 4000, 10, 3);
    expect(g.width).toBe(2000);
    expect(g.height).toBe(5);
    expect(g.gray.every((v) => v === 255)).toBe(true);
  });
});
