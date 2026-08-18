"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Topbar() {
  const pathname = usePathname();
  const navItems = [
    { href: "/stats", label: "统计看板" },
    { href: "/llms", label: "LLM 管理" },
    { href: "/logs", label: "请求日志" },
  ];
  return (
    <header className="topbar">
      <span className="brand">LLM Relay</span>
      <nav>
        {navItems.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={pathname?.startsWith(n.href) ? "active" : ""}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
