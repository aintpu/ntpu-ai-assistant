/** @type {import('next').NextConfig} */
const nextConfig = {
  // 靜態輸出：本應用整個是 client component，沒有 route handler、
  // 沒有伺服器端取資料，因此可直接輸出成靜態檔，交由 Cloudflare
  // Workers Static Assets 供應（與後端同一個 Worker，同源免 CORS）。
  output: "export",
  // dev 模式下 Next 會擋掉非 localhost 來源的請求；demo 走 Cloudflare Tunnel
  // （~/.cloudflared/config.yml：ntpuaia.aifitesg.org → localhost:3000）故須列入。
  allowedDevOrigins: [
    'ntpuaia.aifitesg.org',
    '*.aifitesg.org',
    'sydney-valves-caring-clara.trycloudflare.com',
    '*.trycloudflare.com',
  ],
};
export default nextConfig;
