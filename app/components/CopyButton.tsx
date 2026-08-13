"use client";
import { useState, useCallback, type ReactNode } from "react";

interface Props {
  /** 要复制的文本 */
  value: string;
  /** 按钮内显示的文本（可选） */
  label?: string;
  /** 是否只显示 icon（用于紧凑场景） */
  iconOnly?: boolean;
  className?: string;
}

/** 复制 icon SVG */
function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
    </svg>
  );
}

export function CopyButton({ value, label, iconOnly, className }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 兜底：用临时 textarea
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""} ${className || ""}`}
      onClick={onCopy}
      title={copied ? "已复制" : "复制"}
      aria-label="复制"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {!iconOnly && <span>{copied ? "已复制" : label || "复制"}</span>}
    </button>
  );
}

/** 带文本和复制 icon 的展示单元 */
export function CopyableText({ value }: { value: string }) {
  return (
    <span className="url-cell">
      <span className="url-text" title={value}>
        {value}
      </span>
      <CopyButton value={value} iconOnly />
    </span>
  );
}

/** 给任意 children 旁加复制 icon */
export function WithCopy({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return (
    <span className="url-cell">
      {children}
      <CopyButton value={value} iconOnly />
    </span>
  );
}
