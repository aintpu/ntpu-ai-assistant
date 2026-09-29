// 自訂 404：Next.js 內建的 not-found 頁面使用 inline style 與 <style>，
// 會被不含 'unsafe-inline' 的 CSP 擋掉，因此改用 Tailwind class。
import Link from "next/link";

export const metadata = {
  title: "404: 找不到頁面 | NTPU AI Assistant",
};

export default function NotFound() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-5xl font-semibold text-[#1e3a6e]">404</p>
      <h1 className="text-lg font-medium">找不到這個頁面</h1>
      <p className="text-sm text-gray-500">This page could not be found.</p>
      <Link
        href="/"
        className="rounded-lg bg-[#1e3a6e] px-4 py-2 text-sm font-medium text-white hover:bg-[#163059]"
      >
        回到首頁
      </Link>
    </main>
  );
}
