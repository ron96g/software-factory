"use client";
import { Box, Code, useComputedColorScheme } from "@mantine/core";
import { useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Re-initialized per render so diagrams follow the active color scheme (ADR-0018). securityLevel stays strict.
const loadMermaid = (scheme: "light" | "dark") =>
  import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, theme: scheme === "dark" ? "dark" : "neutral", securityLevel: "strict" });
    return m.default;
  });

function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const scheme = useComputedColorScheme("light");
  useEffect(() => {
    let alive = true;
    loadMermaid(scheme)
      .then((m) => m.render(`m${id}`, code))
      .then((r) => alive && setSvg(r.svg))
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [code, id, scheme]);
  if (err) return <Code block>{`Mermaid error: ${err}\n\n${code}`}</Code>;
  return <Box my="sm" style={{ overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Markdown (CommonMark + GFM: tables, task lists, strikethrough, autolinks) with Mermaid rendering (ADR-0013). */
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="sf-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children: c }) {
            const text = String(c ?? "").replace(/\n$/, "");
            if (/language-mermaid/.test(className ?? "")) return <Mermaid code={text} />;
            return <code className={className}>{c}</code>;
          },
          // Wide agent tables scroll instead of breaking the layout.
          table({ children: c }) {
            return (
              <div className="sf-table-wrap">
                <table>{c}</table>
              </div>
            );
          },
          a({ href, children: c }) {
            const external = !!href && /^https?:/.test(href);
            return (
              <a href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
                {c}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
