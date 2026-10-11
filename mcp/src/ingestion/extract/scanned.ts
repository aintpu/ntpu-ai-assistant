import { zlibSync } from "fflate";
import { extractImages, getDocumentProxy } from "unpdf";

/**
 * 掃描型 PDF 的 OCR（第二階段，使用者 2026-10-11 同意）：Workers 無法把 PDF 畫成圖片，
 * 改從每頁取出內嵌的掃描圖（PDF.js 解碼成像素），轉成灰階 PNG 交給看圖模型。
 * 2026-10-11 抽樣：Flate 與 JPEG 編碼的掃描圖可以取出；傳真格式（CCITT）unpdf 無法解碼，標記後留待日後處理。
 */

/** 小於這個像素數的圖片是頁面上的小圖示、印章，不是整頁掃描。 */
const MIN_PAGE_PIXELS = 500_000;
/** 長邊縮到這個像素以內：OCR 夠清楚，也控制圖片大小與模型用量。 */
const MAX_SIDE = 2000;

export interface ScannedPages {
  pages: number;
  /** 每頁一張 PNG（依頁序，取不出圖的頁跳過）。 */
  images: { page: number; png: Uint8Array }[];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8 位元灰階 PNG。 */
export function grayPng(gray: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibSync(raw, { level: 6 })),
    pngChunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 像素轉灰階，並以區塊平均縮到長邊 MAX_SIDE 以內。 */
export function toGray(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
): { gray: Uint8Array; width: number; height: number } {
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
  const w = Math.floor(width / scale);
  const h = Math.floor(height / scale);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = ((y * scale + dy) * width + (x * scale + dx)) * channels;
          sum += channels >= 3 ? (data[p]! * 299 + data[p + 1]! * 587 + data[p + 2]! * 114) / 1000 : data[p]!;
        }
      }
      gray[y * w + x] = Math.round(sum / (scale * scale));
    }
  }
  return { gray, width: w, height: h };
}

/** 取出前 maxPages 頁的整頁掃描圖。取不出（例如傳真格式）時 images 為空。 */
export async function scannedPageImages(bytes: Uint8Array, maxPages: number): Promise<ScannedPages> {
  const pdf = await getDocumentProxy(bytes.slice());
  const images: ScannedPages["images"] = [];
  for (let page = 1; page <= Math.min(pdf.numPages, maxPages); page++) {
    let found: { data: ArrayLike<number>; width: number; height: number; channels: number }[];
    try {
      found = (await extractImages(pdf, page)) as typeof found;
    } catch {
      continue;
    }
    const largest = found
      .filter((im) => im.width * im.height >= MIN_PAGE_PIXELS)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!largest) continue;
    const g = toGray(largest.data, largest.width, largest.height, largest.channels);
    images.push({ page, png: grayPng(g.gray, g.width, g.height) });
  }
  return { pages: pdf.numPages, images };
}
