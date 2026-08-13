import type { Metadata } from "next";
import "./globals.css";
import { Topbar } from "@/app/components/Topbar";
import { ToastProvider } from "@/app/components/Toast";

export const metadata: Metadata = {
  title: "LLM 中转站",
  description: "LLM 请求中转代理 + 配置与日志管理",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <ToastProvider>
          <div className="app-shell">
            <Topbar />
            <main className="main">{children}</main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
