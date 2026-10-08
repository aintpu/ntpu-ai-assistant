import { IngestionError } from "../../shared/errors";

/** 送給看圖模型的圖片上限（base64 後約 1.33 倍）。 */
export const MAX_OCR_BYTES = 4 * 1024 * 1024;

const PROMPT =
  "請逐字轉寫這張圖片中所有可見的文字（保留原文，繁體中文照原樣），不要描述圖片、不要加任何說明。" +
  "沒有文字就只回答「（無文字）」。";

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 最小介面：正式環境是 Workers AI 綁定，測試可換成假的。 */
export interface VisionModel {
  run(model: string, input: unknown): Promise<unknown>;
}

/**
 * 用 Workers AI 的看圖模型辨識圖片文字（資料不離開 Cloudflare）。
 * 2026-10-08 實測 Mistral Small 3.1 可讀中文海報，偶有錯字；辨識結果只用於搜尋，回答時附原檔連結。
 */
export async function ocrImage(ai: VisionModel, model: string, bytes: Uint8Array, mime: string): Promise<string> {
  if (bytes.byteLength > MAX_OCR_BYTES) throw new IngestionError("FETCH_TOO_LARGE", "image too large for OCR");
  let out: unknown;
  try {
    out = await ai.run(model, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${base64(bytes)}` } },
          ],
        },
      ],
      max_tokens: 2000,
    });
  } catch (err) {
    throw new IngestionError("DEPENDENCY_UNAVAILABLE", `OCR failed: ${(err as Error).message}`.slice(0, 200));
  }
  const text = typeof out === "object" && out && "response" in out ? String((out as { response: unknown }).response ?? "") : "";
  // 模型有時在轉寫完的文字後面多加「（無文字）」（2026-10-08 staging 實測），一律去掉
  return text.replace(/[（(]無文字[）)]?/g, "").trim();
}
