import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Learning Orbit 共學課堂",
  description: "匿名共學課堂：對話、概念圖與互動網絡只呈現伺服器已確認的內容，沒有確認就明說未確認。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // zh-Hant-HK, not zh-Hant: the generic Traditional tag resolves to the Taiwan
  // glyph cut, which draws 骨 / 者 / 換 differently from the Hong Kong EDB
  // standard forms these students are taught to write.
  return (
    <html lang="zh-Hant-HK">
      <body>{children}</body>
    </html>
  );
}
