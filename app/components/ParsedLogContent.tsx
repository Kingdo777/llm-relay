import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ParsedLogContent } from "@/lib/types";

function safeUrl(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, "https://local.invalid");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

export function ParsedLogContentView({
  content,
  mode,
}: {
  content: ParsedLogContent;
  mode: "input" | "output";
}) {
  const visibleEntries = content.entries.filter((entry) => mode === "input"
    ? entry.role === "user"
    : entry.role === "assistant" || entry.role === "response");
  const latestEntry = visibleEntries.at(-1);
  const texts = latestEntry?.blocks.filter(
    (block) => block.type === "text"
      && (mode === "input" || block.format === "markdown")
      && !block.text.trimStart().startsWith("<system-reminder>")
  ) ?? [];

  return (
    <div className="parsed-content">
      {texts.length === 0 && (
        <div className="muted">
          {mode === "input" ? "（本轮无新增用户文本）" : "（本轮无最终用户输出）"}
        </div>
      )}
      {texts.map((block, index) => block.type === "text" && (
        block.format === "plain" ? (
          <pre className="code-block" key={index}>{block.text}</pre>
        ) : (
          <div className="markdown-body" key={index}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              urlTransform={(url) => safeUrl(url) ?? ""}
              components={{
                a: ({ href, children, ...props }) => (
                  <a {...props} href={safeUrl(href)} target="_blank" rel="noreferrer noopener">{children}</a>
                ),
              }}
            >
              {block.text}
            </ReactMarkdown>
          </div>
        )
      ))}
    </div>
  );
}
