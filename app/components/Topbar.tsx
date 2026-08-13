"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Topbar() {
  const pathname = usePathname();
  const navItems = [
    { href: "/llms", label: "LLM 管理" },
    { href: "/logs", label: "请求日志" },
  ];
  return (
    <header className="topbar">
      <span className="brand">🔀 LLM 中转站</span>
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
