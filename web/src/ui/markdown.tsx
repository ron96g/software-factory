"use client";
import { Box, Code, useComputedColorScheme } from "@mantine/core";
import { useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";

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

/** Markdown with Mermaid rendering (ADR-0013). */
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="sf-markdown">
      <ReactMarkdown
        components={{
          code({ className, children: c }) {
            const text = String(c ?? "").replace(/\n$/, "");
            if (/language-mermaid/.test(className ?? "")) return <Mermaid code={text} />;
            return <code className={className}>{c}</code>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
