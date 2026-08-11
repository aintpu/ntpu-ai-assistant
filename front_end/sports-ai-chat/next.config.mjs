/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
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
