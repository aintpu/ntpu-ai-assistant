import "./globals.css";

export const metadata = {
  title: "NTPU AI Assistant",
  description: "國立臺北大學 AI 助理",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-TW" className="h-full">
      <body className="h-full bg-white text-gray-900 font-sans">{children}</body>
    </html>
  );
}
